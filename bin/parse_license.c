/*
 * parse_license.c
 *
 * Parses and verifies a license file produced by mklicense.c or the server:
 *   license_b64 = Base64( {
 *     "algorithm": "RSA-SHA256",
 *     "payload": { "machine_id":"...", "updated_at":"...", "duration":N, "feature":N, "license_type":"paid|trial" },
 *     "signature": "<Base64(RSA-SHA256(payload_json_bytes))>"
 *   } )
 *
 * Strategy:
 *   1) Base64-decode input to license JSON
 *   2) Extract 'algorithm' (must be RSA-SHA256)
 *   3) Extract raw 'payload' JSON substring (the exact bytes are signed)
 *   4) Extract 'signature' Base64 and decode to bytes
 *   5) Verify signature over the raw payload JSON using server public key
 *   6) Lightly "parse" payload to print key fields (no full JSON lib used)
 *
 * Build: cc -O2 -Wall parse_license.c -o parse_license -lcrypto
 * 
 * ./parse_license --pub server_public_key.pem --in license.b64
# You can also pipe:  cat license.b64 | ./parse_license --pub server_public_key.pem

 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>

static const char* get_arg(int argc, char** argv, const char* flag, const char* defval) {
    for (int i=1; i<argc-1; ++i) {
        if (strcmp(argv[i], flag) == 0) return argv[i+1];
    }
    return defval;
}

static char* slurp_fd(FILE* f, size_t* out_len) {
    size_t cap = 4096, n = 0;
    char* buf = (char*)malloc(cap);
    if (!buf) return NULL;
    int c;
    while ((c = fgetc(f)) != EOF) {
        if (n+1 >= cap) {
            cap *= 2;
            char* nb = (char*)realloc(buf, cap);
            if (!nb) { free(buf); return NULL; }
            buf = nb;
        }
        buf[n++] = (char)c;
    }
    buf[n] = '\0';
    if (out_len) *out_len = n;
    return buf;
}

static void trim_inplace(char* s) {
    size_t len = strlen(s);
    size_t i=0, j=len;
    while (i<len && isspace((unsigned char)s[i])) i++;
    while (j>i && isspace((unsigned char)s[j-1])) j--;
    size_t newlen = j-i;
    memmove(s, s+i, newlen);
    s[newlen] = '\0';
}

/* ---- Base64 decode using OpenSSL BIO (NO_NL) ---- */
static unsigned char* b64_decode(const char* in, size_t inlen, size_t* outlen) {
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *bmem = BIO_new_mem_buf(in, (int)inlen);
    if (!b64 || !bmem) { if (b64) BIO_free(b64); if (bmem) BIO_free(bmem); return NULL; }
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO *bio = BIO_push(b64, bmem);

    size_t cap = (inlen*3)/4 + 8;
    unsigned char* out = (unsigned char*)malloc(cap);
    if (!out) { BIO_free_all(bio); return NULL; }

    int n = BIO_read(bio, out, (int)cap);
    if (n <= 0) { free(out); BIO_free_all(bio); return NULL; }

    *outlen = (size_t)n;
    BIO_free_all(bio);
    return out;
}

/* ---- Load server public key (PEM) ---- */
static EVP_PKEY* load_public_key(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return NULL;
    EVP_PKEY* pk = PEM_read_PUBKEY(f, NULL, NULL, NULL);
    fclose(f);
    return pk;
}

/* ---- Naive JSON helpers (no external lib) ---- */
static const char* find_key(const char* json, const char* key) {
    size_t klen = strlen(key);
    const char* p = json;
    while ((p = strstr(p, key))) {
        /* Ensure it's a JSON key: must be quoted "key" (caller includes quotes) */
        /* And next non-ws char after key should be ':' */
        const char* q = p + klen;
        while (*q && isspace((unsigned char)*q)) q++;
        if (*q == ':') return q+1;
        p = p + 1;
    }
    return NULL;
}

/* Get string value at position (after colon). Returns malloc'd string (unescaped minimal), or NULL */
static char* get_json_string_after_colon(const char* pos) {
    while (*pos && isspace((unsigned char)*pos)) pos++;
    if (*pos != '\"') return NULL;
    pos++;
    size_t cap = 128, n = 0;
    char* out = (char*)malloc(cap);
    if (!out) return NULL;
    int esc = 0;
    for (; *pos; ++pos) {
        char c = *pos;
        if (esc) {
            /* minimal unescape for \" and \\ and \n, \t, \r; ignore \uXXXX for simplicity */
            char v = c;
            if (c=='n') v = '\n'; else if (c=='t') v = '\t'; else if (c=='r') v = '\r';
            if (n+1 >= cap) { cap*=2; char* nb = (char*)realloc(out, cap); if(!nb){ free(out); return NULL; } out=nb; }
            out[n++] = v;
            esc = 0;
        } else if (c == '\\') {
            esc = 1;
        } else if (c == '\"') {
            break;
        } else {
            if (n+1 >= cap) { cap*=2; char* nb = (char*)realloc(out, cap); if(!nb){ free(out); return NULL; } out=nb; }
            out[n++] = c;
        }
    }
    out[n] = '\0';
    return out;
}

/* Get integer value at position (after colon). */
static int get_json_int_after_colon(const char* pos, int* ok) {
    while (*pos && isspace((unsigned char)*pos)) pos++;
    char* endptr = NULL;
    long v = strtol(pos, &endptr, 10);
    if (endptr == pos) { *ok = 0; return 0; }
    *ok = 1;
    return (int)v;
}

/* Extract raw payload JSON substring (including outer { ... }) */
static int extract_payload_raw(const char* lic_json, const char** out_start, size_t* out_len) {
    const char* key = "\"payload\"";
    const char* kpos = strstr(lic_json, key);
    if (!kpos) return 0;
    const char* pos = strchr(kpos, '{');
    if (!pos) return 0;

    const char* p = pos;
    int depth = 0, in_str = 0, esc = 0;
    for (; *p; ++p) {
        char c = *p;
        if (in_str) {
            if (esc) esc = 0;
            else if (c == '\\') esc = 1;
            else if (c == '"') in_str = 0;
        } else {
            if (c == '"') in_str = 1;
            else if (c == '{') { if (depth == 0) *out_start = p; depth++; }
            else if (c == '}') { depth--; if (depth == 0) { *out_len = (size_t)(p - *out_start + 1); return 1; } }
        }
    }
    return 0;
}

static char* extract_signature_b64(const char* lic_json) {
    const char* valpos = find_key(lic_json, "\"signature\"");
    if (!valpos) return NULL;
    return get_json_string_after_colon(valpos);
}

static char* extract_algorithm(const char* lic_json) {
    const char* valpos = find_key(lic_json, "\"algorithm\"");
    if (!valpos) return NULL;
    return get_json_string_after_colon(valpos);
}

/* ---- Verify RSA-SHA256 over payload bytes ---- */
static int verify_signature(EVP_PKEY* pub, const unsigned char* msg, size_t msg_len,
                            const unsigned char* sig, size_t sig_len) {
    int ok = 0;
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) return 0;
    if (EVP_DigestVerifyInit(ctx, NULL, EVP_sha256(), NULL, pub) != 1) goto done;
    if (EVP_DigestVerifyUpdate(ctx, msg, msg_len) != 1) goto done;
    ok = (EVP_DigestVerifyFinal(ctx, sig, sig_len) == 1);
done:
    EVP_MD_CTX_free(ctx);
    return ok;
}

int main(int argc, char** argv) {
    const char* pub_path = get_arg(argc, argv, "--pub", NULL);
    const char* in_path  = get_arg(argc, argv, "--in", NULL);

    if (!pub_path) {
        fprintf(stderr, "Usage: %s --pub server_public_key.pem [--in license.b64]\n", argv[0]);
        return 2;
    }

    /* Read license.b64 */
    char* lic_b64 = NULL;
    size_t lic_b64_len = 0;
    if (in_path) {
        FILE* f = fopen(in_path, "rb");
        if (!f) { fprintf(stderr, "Cannot open --in: %s\n", in_path); return 1; }
        lic_b64 = slurp_fd(f, &lic_b64_len);
        fclose(f);
    } else {
        lic_b64 = slurp_fd(stdin, &lic_b64_len);
    }
    if (!lic_b64) { fprintf(stderr, "Failed to read license input\n"); return 1; }
    trim_inplace(lic_b64);

    /* Base64 decode -> license JSON */
    size_t lic_json_len = 0;
    unsigned char* lic_json_bin = b64_decode(lic_b64, strlen(lic_b64), &lic_json_len);
    if (!lic_json_bin) { fprintf(stderr, "Base64 decode failed\n"); free(lic_b64); return 1; }

    char* lic_json = (char*)malloc(lic_json_len + 1);
    if (!lic_json) { free(lic_b64); free(lic_json_bin); return 1; }
    memcpy(lic_json, lic_json_bin, lic_json_len);
    lic_json[lic_json_len] = '\0';

    /* Extract algorithm */
    char* algo = extract_algorithm(lic_json);
    if (!algo || strcmp(algo, "RSA-SHA256") != 0) {
        fprintf(stderr, "Unsupported or missing algorithm (got: %s)\n", algo ? algo : "NULL");
        free(algo); free(lic_b64); free(lic_json_bin); free(lic_json);
        return 1;
    }

    /* Extract raw payload JSON bytes (exactly as signed) */
    const char* payload_start = NULL;
    size_t payload_len = 0;
    if (!extract_payload_raw(lic_json, &payload_start, &payload_len)) {
        fprintf(stderr, "Failed to locate payload JSON\n");
        free(algo); free(lic_b64); free(lic_json_bin); free(lic_json);
        return 1;
    }

    /* Extract signature (Base64 -> bytes) */
    char* sig_b64 = extract_signature_b64(lic_json);
    if (!sig_b64) {
        fprintf(stderr, "Missing signature field\n");
        free(algo); free(lic_b64); free(lic_json_bin); free(lic_json);
        return 1;
    }
    size_t sig_len = 0;
    unsigned char* sig = b64_decode(sig_b64, strlen(sig_b64), &sig_len);
    if (!sig) {
        fprintf(stderr, "Signature Base64 decode failed\n");
        free(sig_b64); free(algo); free(lic_b64); free(lic_json_bin); free(lic_json);
        return 1;
    }

    /* Load server public key and verify */
    EVP_PKEY* pub = load_public_key(pub_path);
    if (!pub) {
        fprintf(stderr, "Failed to load public key: %s\n", pub_path);
        free(sig); free(sig_b64); free(algo); free(lic_b64); free(lic_json_bin); free(lic_json);
        return 1;
    }

    int verified = verify_signature(pub,
                                    (const unsigned char*)payload_start,
                                    payload_len,
                                    sig, sig_len);

    printf("Signature: %s\n", verified ? "VALID" : "INVALID");

    /* Optional: parse fields inside payload for convenience */
    char* payload_copy = (char*)malloc(payload_len + 1);
    memcpy(payload_copy, payload_start, payload_len);
    payload_copy[payload_len] = '\0';

    /* Extract fields (naive scan) */
    char* pos;
    char* machine_id = NULL; char* updated_at = NULL; char* license_type = NULL;
    int oknum=0, duration=0, feature=0;

    pos = find_key(payload_copy, "\"machine_id\"");
    if (pos) machine_id = get_json_string_after_colon(pos);

    pos = find_key(payload_copy, "\"updated_at\"");
    if (pos) updated_at = get_json_string_after_colon(pos);

    pos = find_key(payload_copy, "\"license_type\"");
    if (pos) license_type = get_json_string_after_colon(pos);

    pos = find_key(payload_copy, "\"duration\"");
    if (pos) duration = get_json_int_after_colon(pos, &oknum);

    pos = find_key(payload_copy, "\"feature\"");
    if (pos) feature = get_json_int_after_colon(pos, &oknum);

    printf("Payload (raw JSON): %.*s\n", (int)payload_len, payload_start);
    printf("Fields:\n");
    printf("  machine_id   : %s\n", machine_id ? machine_id : "(none)");
    printf("  updated_at   : %s\n", updated_at ? updated_at : "(none)");
    printf("  duration     : %d\n", duration);
    printf("  feature      : %d\n", feature);
    printf("  license_type : %s\n", license_type ? license_type : "(none)");

    /* Cleanup */
    EVP_PKEY_free(pub);
    free(machine_id); free(updated_at); free(license_type);
    free(payload_copy);
    free(sig); free(sig_b64); free(algo);
    free(lic_b64); free(lic_json_bin); free(lic_json);
    return verified ? 0 : 3;
}
