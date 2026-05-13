/*
gcc -O2 -Wall -Wextra -o machine_id machine_id.c -lcrypto

*/
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <unistd.h>
#include <dirent.h>
#include <limits.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <ifaddrs.h>
#include <sys/socket.h>
#include <net/if.h>
#include <linux/if_packet.h>   // sockaddr_ll

#include <openssl/sha.h>

/* ---------- small helpers ---------- */

static int g_verbose = 0;

static void trim(char *s) {
    size_t n = strlen(s);
    size_t i = 0, j = n;
    while (i < n && isspace((unsigned char)s[i])) i++;
    while (j > i && isspace((unsigned char)s[j-1])) j--;
    if (i) memmove(s, s+i, j-i);
    s[j-i] = '\0';
}

static char* slurp_first_line(const char* path) {
    FILE* f = fopen(path, "r");
    if (!f) return NULL;
    char* line = NULL;
    size_t cap = 0;
    ssize_t n = getline(&line, &cap, f);
    fclose(f);
    if (n <= 0) { free(line); return NULL; }
    trim(line);
    if (!*line) { free(line); return NULL; }
    return line;
}

static int looks_valid_serial(const char* s) {
    if (!s || !*s) return 0;
    // reject common placeholders
    if (!strcasecmp(s, "None")) return 0;
    if (!strcasecmp(s, "Unknown")) return 0;
    if (!strcasecmp(s, "To Be Filled By O.E.M.") || !strcasecmp(s, "To be filled by O.E.M.")) return 0;
    if (!strcmp(s, "00000000-0000-0000-0000-000000000000")) return 0;
    return 1;
}

static void upper_inplace(char* s) {
    for (; *s; ++s) *s = (char)toupper((unsigned char)*s);
}

/* ---------- board serial (DMI) with fallbacks ---------- */

static char* get_board_serial(void) {
    const char* candidates[] = {
        "/sys/class/dmi/id/board_serial",
        "/sys/class/dmi/id/product_uuid",
        "/sys/class/dmi/id/board_asset_tag",
        NULL
    };
    for (int i=0; candidates[i]; i++) {
        char* s = slurp_first_line(candidates[i]);
        if (s && looks_valid_serial(s)) return s;
        free(s);
    }
    // /proc/cpuinfo "Serial" (e.g., Raspberry Pi)
    FILE* f = fopen("/proc/cpuinfo", "r");
    if (f) {
        char *line = NULL; size_t cap = 0;
        while (getline(&line, &cap, f) > 0) {
            if (!strncasecmp(line, "Serial", 6)) {
                char* colon = strchr(line, ':');
                if (colon) {
                    char* s = strdup(colon+1);
                    if (s) { trim(s); fclose(f); free(line); if (looks_valid_serial(s)) return s; free(s); break; }
                }
            }
        }
        free(line);
        fclose(f);
    }
    return NULL;
}

/* ---------- first physical MAC (non-loopback, non-virtual-ish) ---------- */

static int is_bad_mac(const unsigned char* mac, int len) {
    if (len < 6) return 1;
    int all0 = 1, allF = 1;
    for (int i=0; i<len; i++) {
        if (mac[i] != 0x00) all0 = 0;
        if (mac[i] != 0xFF) allF = 0;
    }
    return all0 || allF;
}

static int looks_virtual_name(const char* name) {
    return !strncmp(name, "lo", 2) ||
           !strncmp(name, "docker", 6) ||
           !strncmp(name, "veth", 4) ||
           !strncmp(name, "br-", 3) ||
           !strncmp(name, "virbr", 5) ||
           !strncmp(name, "tun", 3) ||
           !strncmp(name, "tap", 3);
}

static char* first_physical_mac_hex(void) {
    struct ifaddrs* ifs = NULL;
    if (getifaddrs(&ifs) != 0) return NULL;

    char* out = NULL;
    for (struct ifaddrs* it = ifs; it; it = it->ifa_next) {
        if (!it->ifa_addr) continue;
        if (it->ifa_addr->sa_family != AF_PACKET) continue;
        if (it->ifa_flags & IFF_LOOPBACK) continue;
        const char* name = it->ifa_name ? it->ifa_name : "";
        if (looks_virtual_name(name)) continue;

        struct sockaddr_ll* sll = (struct sockaddr_ll*)it->ifa_addr;
        if (sll->sll_halen < 6) continue;
        if (is_bad_mac(sll->sll_addr, sll->sll_halen)) continue;

        size_t outlen = sll->sll_halen * 2;
        out = (char*)malloc(outlen + 1);
        if (!out) break;
        static const char* hex="0123456789ABCDEF";
        for (int i=0;i<sll->sll_halen;i++){
            out[i*2]   = hex[(sll->sll_addr[i]>>4)&0xF];
            out[i*2+1] = hex[(sll->sll_addr[i])&0xF];
        }
        out[outlen] = '\0';
        break;
    }
    freeifaddrs(ifs);
    return out;
}

/* ---------- root disk serial ---------- */

/* Find the device path that is mounted at "/" from /proc/mounts */
static char* root_mount_device(void) {
    FILE* f = fopen("/proc/mounts", "r");
    if (!f) return NULL;
    char dev[PATH_MAX], mnt[PATH_MAX], fs[64];
    char buf[PATH_MAX*2];
    char* out = NULL;
    while (fgets(buf, sizeof(buf), f)) {
        if (sscanf(buf, "%1023s %1023s %63s", dev, mnt, fs) == 3) {
            if (!strcmp(mnt, "/")) {
                out = strdup(dev);
                break;
            }
        }
    }
    fclose(f);
    return out;
}

/* Reduce a partition name to base disk (sda1 -> sda, nvme0n1p2 -> nvme0n1, mmcblk0p1 -> mmcblk0) */
static void to_base_disk(char* name) {
    size_t n = strlen(name);
    // If nvme...pN or mmcblk...pN -> strip trailing 'p<digits>'
    char* p = NULL;
    if ((p = strrchr(name, 'p'))) {
        int all_digits = 1;
        for (char* q = p+1; *q; q++) if (!isdigit((unsigned char)*q)) { all_digits = 0; break; }
        if (all_digits) *p = '\0';
        return;
    }
    // Else strip trailing digits (sda1 -> sda)
    while (n>0 && isdigit((unsigned char)name[n-1])) name[--n] = '\0';
}

/* Read disk serial from sysfs: /sys/class/block/<base>/device/serial */
static char* disk_serial_from_sys(const char* devpath) {
    // devpath like /dev/sda1, /dev/nvme0n1p2, /dev/mapper/...
    const char* base = strrchr(devpath, '/');
    if (!base) return NULL;
    base++;
    char blk[NAME_MAX+1]; snprintf(blk, sizeof(blk), "%s", base);

    // /dev/mapper/dm-* -> find actual dm name
    if (!strncmp(blk, "mapper/", 7)) {
        // Not typical here; keep as-is.
    }
    // If it's a partition, reduce to base
    to_base_disk(blk);

    char path[PATH_MAX];
    snprintf(path, sizeof(path), "/sys/class/block/%s/device/serial", blk);
    char* s = slurp_first_line(path);
    if (s && looks_valid_serial(s)) return s;
    free(s);

    // Try WWID as fallback
    snprintf(path, sizeof(path), "/sys/class/block/%s/device/wwid", blk);
    s = slurp_first_line(path);
    if (s && looks_valid_serial(s)) return s;
    free(s);

    return NULL;
}

/* Fallback: match /dev/disk/by-id symlink pointing to our root dev or its base, use its filename */
static char* disk_serial_from_byid(const char* devpath) {
    char devbase[NAME_MAX+1];
    const char* b = strrchr(devpath, '/'); b = b ? b+1 : devpath;
    snprintf(devbase, sizeof(devbase), "%s", b);
    to_base_disk(devbase);

    DIR* d = opendir("/dev/disk/by-id");
    if (!d) return NULL;
    struct dirent* ent;
    char linkpath[PATH_MAX], target[PATH_MAX];
    char* best = NULL;

    while ((ent = readdir(d))) {
        if (ent->d_name[0] == '.') continue;
        snprintf(linkpath, sizeof(linkpath), "/dev/disk/by-id/%s", ent->d_name);
        ssize_t n = readlink(linkpath, target, sizeof(target)-1);
        if (n <= 0) continue;
        target[n] = '\0';
        const char* tb = strrchr(target, '/');
        tb = tb ? tb+1 : target;

        // If symlink points to this base (or partition), accept
        if (!strncmp(tb, devbase, strlen(devbase))) {
            // Use the by-id filename (often contains model+serial)
            best = strdup(ent->d_name);
            break;
        }
    }
    closedir(d);
    return best;
}

static char* get_root_disk_serial(void) {
    char* dev = root_mount_device();
    if (!dev) return NULL;

    char* s = disk_serial_from_sys(dev);
    if (!s) s = disk_serial_from_byid(dev);
    free(dev);
    return s;
}

/* ---------- SHA-256 hex ---------- */

static char* sha256_hex(const unsigned char* data, size_t len) {
    unsigned char dig[SHA256_DIGEST_LENGTH];
    SHA256(data, len, dig);
    char* out = (char*)malloc(SHA256_DIGEST_LENGTH*2 + 1);
    static const char* hex = "0123456789abcdef";
    for (int i=0;i<SHA256_DIGEST_LENGTH;i++){ out[i*2]=hex[(dig[i]>>4)&0xF]; out[i*2+1]=hex[dig[i]&0xF]; }
    out[SHA256_DIGEST_LENGTH*2] = '\0';
    return out;
}

/* ---------- main ---------- */

int main(int argc, char** argv) {
    for (int i=1;i<argc;i++) if (!strcmp(argv[i],"--verbose")) g_verbose=1;

    char* board = get_board_serial();            if (board) upper_inplace(board);
    char* mac   = first_physical_mac_hex();      // already uppercase
    char* disk  = get_root_disk_serial();        if (disk) upper_inplace(disk);

    if (g_verbose) {
        fprintf(stderr, "board_serial = %s\n", board ? board : "(none)");
        fprintf(stderr, "disk_serial  = %s\n",  disk ? disk  : "(none)");
        fprintf(stderr, "mac_address  = %s\n",  mac  ? mac   : "(none)");
    }

    // Build canonical string (include labels to avoid ambiguity)
    // Use placeholders to keep stability of the format if some fields are missing.
    const char* nb = board ? board : "N/A";
    const char* nd = disk  ? disk  : "N/A";
    const char* nm = mac   ? mac   : "N/A";

    // Concatenate with fixed separators
    char buf[4096];
    int n = snprintf(buf, sizeof(buf), "BOARD:%s|DISK:%s|MAC:%s", nb, nd, nm);
    if (n < 0 || n >= (int)sizeof(buf)) {
        fprintf(stderr, "internal error: id concat too long\n");
        free(board); free(mac); free(disk);
        return 2;
    }

    // Produce fixed-length machine_id = SHA-256 hex of the canonical string
    char* id = sha256_hex((const unsigned char*)buf, (size_t)n);
    if (!id) {
        fprintf(stderr, "sha256 error\n");
        free(board); free(mac); free(disk);
        return 2;
    }
    printf("%s\n", id);

    free(id);
    free(board); free(mac); free(disk);
    return 0;
}
