/* Offline oracle for the user's installed Desktop library; no networking or account state.
 * Compile: clang -Wall -Wextra -Werror scripts/research/native-cronet-digest.c -o /tmp/<chosen-name>
 * Run with the absolute path of the installed libsscronet.dylib.
 * Intentionally never resolves/calls Engine_StartWithParams or UrlRequest_Create/Start.
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *symbol(void *library, const char *name) {
  void *value = dlsym(library, name);
  if (!value) { fprintf(stderr, "missing export: %s\n", name); exit(2); }
  return value;
}

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: %s <installed libsscronet.dylib>\n", argv[0]); return 2; }
  void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!library) { fprintf(stderr, "%s\n", dlerror()); return 2; }
  void *(*engine_create)(void) = symbol(library, "Cronet_Engine_Create");
  void (*engine_destroy)(void *) = symbol(library, "Cronet_Engine_Destroy");
  void *(*params_create)(void) = symbol(library, "Cronet_UrlRequestParams_Create");
  void (*params_destroy)(void *) = symbol(library, "Cronet_UrlRequestParams_Destroy");
  void (*set_md5)(void *, void *, const void *, uint64_t) = symbol(library, "Cronet_Engine_SetMD5Header");
  uint32_t (*headers_size)(const void *) = symbol(library, "Cronet_UrlRequestParams_request_headers_size");
  void *(*headers_at)(const void *, uint32_t) = symbol(library, "Cronet_UrlRequestParams_request_headers_at");
  const char *(*header_name)(const void *) = symbol(library, "Cronet_HttpHeader_name_get");
  const char *(*header_value)(const void *) = symbol(library, "Cronet_HttpHeader_value_get");
  static const unsigned char binary[] = { 0x00, 0xff, 0x80, 0x61, 0x00, 0xc3, 0xa9 };
  const struct { const char *name; const void *data; uint64_t size; } fixtures[] = {
    { "empty", "", 0 }, { "abc", "abc", 3 }, { "binary", binary, sizeof(binary) },
  };
  void *engine = engine_create(); // Allocate only: StartWithParams is never called.
  int result = 0;
  for (size_t i = 0; i < sizeof(fixtures) / sizeof(fixtures[0]); i++) {
    void *params = params_create();
    set_md5(engine, params, fixtures[i].data, fixtures[i].size);
    const uint32_t count = headers_size(params);
    if (count != 1) { fprintf(stderr, "unexpected header count: %u\n", count); result = 1; }
    for (uint32_t j = 0; j < count; j++) {
      void *header = headers_at(params, j);
      printf("%s %s=%s\n", fixtures[i].name, header_name(header), header_value(header));
      if (strcmp(header_name(header), "x-ss-stub") != 0) result = 1;
    }
    params_destroy(params);
  }
  engine_destroy(engine);
  dlclose(library);
  return result;
}
