#define CC_SHA256_DIGEST_LENGTH 32
typedef unsigned int CC_LONG;
unsigned char *CC_SHA256(const void *data, CC_LONG len, unsigned char *md);
