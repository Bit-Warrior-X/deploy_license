/*
 * mklicense.c - Generate a license file (no provider_id, no ip, no product_id).
 *
 * Payload (exact key order preserved):
 *  {
 *    "machine_id": "<string>",
 *    "updated_at": "<ISO8601 UTC>",
 *    "duration": <int>,
 *    "feature": <int>,
 *    "license_type": "<trial|l4|l7|unified>"
 *  }
 *
 * License wrapper:
 *  {
 *    "algorithm": "RSA-SHA256",
 *    "payload": <payload>,
 *    "signature": "<Base64(RSA-SHA256(payload_json))>"
 *  }
 *
 * Output: Base64(license_json)
 *
 * Build: cc -O2 -Wall mklicense.c -o mklicense -lcrypto
 * 
 * ./mklicense \
  --key server_private_key.pem \
  --out license.b64 \
  --machine-id 4fd9af68a702432bf27136eab6dad323a0a0b866791878bbc974988fc6b9897a \
  --duration 365 \
  --feature 7 \
  --license-type trial
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>

#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>

/* ---------- CLI helpers ---------- */

static const char* get_arg(int argc, char** argv, const char* flag, const char* defval) {
    for (int i=1; i<argc-1; ++i) {
        if (strcmp(argv[i], flag) == 0) return argv[i+1];
    }
    return defval;
}
static int get_arg_int(int argc, char** argv, const char* flag, int defval) {
    const char* s = get_arg(argc, argv, flag, NULL);
    return s ? atoi(s) : defval;
}

/* ---------- JSON escape (minimal, safe for UTF-8 bytes) ---------- */
static char* json_escape(const char* s) {
    size_t len = strlen(s);
    size_t cap = len * 6 + 1; /* worst-case */
    char* out = (char*)malloc(cap);
    if (!out) return NULL;
    size_t j = 0;
    for (size_t i=0; i<len; ++i) {
        unsigned char c = (unsigned char)s[i];
        if (c == '\"' || c == '\\') {
            if (j+2 >= cap) { cap*=2; out = (char*)realloc(out, cap); if(!out) return NULL; }
            out[j++]='\\'; out[j++]=c;
        } else if (c <= 0x1F) {
            if (j+6 >= cap) { cap*=2; out = (char*)realloc(out, cap); if(!out) return NULL; }
            static const char* hex="0123456789ABCDEF";
            out[j++]='\\'; out[j++]='u'; out[j++]='0'; out[j++]='0';
            out[j++]=hex[(c>>4)&0xF]; out[j++]=hex[c&0xF];
        } else {
            if (j+1 >= cap) { cap*=2; out = (char*)realloc(out, cap); if(!out) return NULL; }
            out[j++] = (char)c;
        }
    }
    out[j] = '\0';
    return out;
}

/* ---------- Base64 (OpenSSL BIO) ---------- */
static char* b64_encode(const unsigned char* data, size_t len) {
    BIO *bmem = NULL, *b64 = NULL;
    BUF_MEM *bptr = NULL;
    char* out = NULL;

    b64 = BIO_new(BIO_f_base64());
    if (!b64) return NULL;
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);

    bmem = BIO_new(BIO_s_mem());
    if (!bmem) { BIO_free(b64); return NULL; }

    BIO_push(b64, bmem);
    if (BIO_write(b64, data, (int)len) <= 0) { BIO_free_all(b64); return NULL; }
    if (BIO_flush(b64) != 1) { BIO_free_all(b64); return NULL; }
    BIO_get_mem_ptr(b64, &bptr);
    if (!bptr || !bptr->data) { BIO_free_all(b64); return NULL; }

    out = (char*)malloc(bptr->length + 1);
    if (!out) { BIO_free_all(b64); return NULL; }
    memcpy(out, bptr->data, bptr->length);
    out[bptr->length] = '\0';

    BIO_free_all(b64);
    return out;
}

/* ---------- Load private key (PEM), optional passphrase ---------- */
static EVP_PKEY* load_private_key(const char* pem_path, const char* pass) {
    FILE* f = fopen(pem_path, "rb");
    if (!f) return NULL;
    EVP_PKEY* pkey = PEM_read_PrivateKey(f, NULL, NULL, (void*)pass);
    fclose(f);
    return pkey;
}

/* ---------- RSA-SHA256 signature ---------- */
static int sign_rsasha256(EVP_PKEY* pkey, const unsigned char* msg, size_t msg_len,
                          unsigned char** sig, size_t* sig_len) {
    int ok = 0;
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) return 0;

    if (EVP_DigestSignInit(ctx, NULL, EVP_sha256(), NULL, pkey) != 1) goto done;
    if (EVP_DigestSignUpdate(ctx, msg, msg_len) != 1) goto done;
    if (EVP_DigestSignFinal(ctx, NULL, sig_len) != 1) goto done;

    *sig = (unsigned char*)malloc(*sig_len);
    if (!*sig) goto done;

    if (EVP_DigestSignFinal(ctx, *sig, sig_len) != 1) goto done;
    ok = 1;

done:
    if (!ok && *sig) { free(*sig); *sig = NULL; }
    EVP_MD_CTX_free(ctx);
    return ok;
}

/* ---------- ISO8601 UTC ---------- */
static void iso8601_utc(char* buf, size_t buflen) {
    time_t t = time(NULL);
    struct tm g;
#if defined(_WIN32)
    gmtime_s(&g, &t);
#else
    gmtime_r(&t, &g);
#endif
    strftime(buf, buflen, "%Y-%m-%dT%H:%M:%SZ", &g);
}

int main(int argc, char** argv) {
    const char* key_path     = get_arg(argc, argv, "--key", NULL);
    const char* out_path     = get_arg(argc, argv, "--out", NULL);

    const char* machine_id   = get_arg(argc, argv, "--machine-id", NULL);
    int   duration           = get_arg_int(argc, argv, "--duration", -1);
    int   feature            = get_arg_int(argc, argv, "--feature", 0);
    const char* license_type = get_arg(argc, argv, "--license-type", "trial"); // trial|l4|l7|unified

    if (!key_path || !machine_id || duration < 0) {
        fprintf(stderr,
            "Usage: %s --key <server_private_key.pem> [--out license.b64]\n"
            "          --machine-id ID --duration DAYS --feature N\n"
            "          [--license-type trial|l4|l7|unified]\n"
            "  (If key is encrypted, set KEY_PASSPHRASE environment variable)\n",
            argv[0]);
        return 2;
    }

    const char* passphrase = getenv("KEY_PASSPHRASE");

#if OPENSSL_VERSION_NUMBER < 0x10100000L
    OpenSSL_add_all_algorithms();
#endif

    EVP_PKEY* pkey = load_private_key(key_path, passphrase);
    if (!pkey) {
        fprintf(stderr, "Failed to load private key: %s\n", key_path);
        return 1;
    }

    /* Prepare payload JSON (no provider_id, ip, product_id), fixed key order */
    char ts[32]; iso8601_utc(ts, sizeof(ts));
    char* mid_esc = json_escape(machine_id);
    char* ltype_esc = json_escape(license_type);
    if (!mid_esc || !ltype_esc) {
        fprintf(stderr, "OOM during JSON escaping\n");
        EVP_PKEY_free(pkey);
        free(mid_esc); free(ltype_esc);
        return 1;
    }

    char* payload = NULL;
    {
        size_t need = 256 + strlen(mid_esc) + strlen(ltype_esc);
        payload = (char*)malloc(need);
        if (!payload) { fprintf(stderr, "OOM payload\n"); EVP_PKEY_free(pkey); return 1; }
        int n = snprintf(payload, need,
            "{\"machine_id\":\"%s\","
            "\"updated_at\":\"%s\","
            "\"duration\":%d,"
            "\"feature\":%d,"
            "\"license_type\":\"%s\"}",
            mid_esc, ts, duration, feature, ltype_esc);
        if (n < 0 || (size_t)n >= need) {
            fprintf(stderr, "payload snprintf truncated\n");
            EVP_PKEY_free(pkey); free(payload); return 1;
        }
    }

    /* Sign payload */
    unsigned char* sig = NULL; size_t sig_len = 0;
    if (!sign_rsasha256(pkey, (const unsigned char*)payload, strlen(payload), &sig, &sig_len)) {
        fprintf(stderr, "Signing failed\n");
        EVP_PKEY_free(pkey); free(payload);
        return 1;
    }
    char* sig_b64 = b64_encode(sig, sig_len);
    if (!sig_b64) {
        fprintf(stderr, "Base64(sig) failed\n");
        EVP_PKEY_free(pkey); free(payload); free(sig);
        return 1;
    }

    /* Assemble license JSON */
    char* license_json = NULL;
    {
        const char* head = "{\"algorithm\":\"RSA-SHA256\",\"payload\":";
        const char* mid  = ",\"signature\":\"";
        const char* tail = "\"}";
        size_t need = strlen(head) + strlen(payload) + strlen(mid) + strlen(sig_b64) + strlen(tail) + 1;
        license_json = (char*)malloc(need);
        if (!license_json) {
            fprintf(stderr, "OOM license_json\n");
            EVP_PKEY_free(pkey); free(payload); free(sig); free(sig_b64);
            return 1;
        }
        snprintf(license_json, need, "%s%s%s%s%s", head, payload, mid, sig_b64, tail);
    }

    /* Base64(license_json) */
    char* license_b64 = b64_encode((const unsigned char*)license_json, strlen(license_json));
    if (!license_b64) {
        fprintf(stderr, "Base64(license_json) failed\n");
        EVP_PKEY_free(pkey); free(payload); free(sig); free(sig_b64); free(license_json);
        return 1;
    }

    /* Output */
    FILE* out = stdout;
    if (out_path) {
        out = fopen(out_path, "wb");
        if (!out) {
            fprintf(stderr, "Cannot open --out path for writing: %s\n", out_path);
            EVP_PKEY_free(pkey); free(payload); free(sig); free(sig_b64); free(license_json); free(license_b64);
            return 1;
        }
    }
    fprintf(out, "%s\n", license_b64);
    if (out_path) fclose(out);

    /* Cleanup */
    EVP_PKEY_free(pkey);
    free(mid_esc); free(ltype_esc);
    free(payload);
    free(sig); free(sig_b64);
    free(license_json);
    free(license_b64);

    return 0;
}
