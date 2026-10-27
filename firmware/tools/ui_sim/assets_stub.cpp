/*
 * Simulator stand-in for firmware/main/assets/assets.cpp: serves PNG bytes from
 * firmware/main/assets/assets_bin (UI_SIM_ASSETS_DIR) instead of the flash partition.
 */
#include <assets/assets.h>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace assets {

static std::map<std::string, std::vector<uint8_t>> cache;

lv_image_dsc_t get_image(std::string_view name)
{
    lv_image_dsc_t dsc = {};
    std::string key(name);
    if (!cache.count(key)) {
        std::string path = std::string(UI_SIM_ASSETS_DIR) + "/" + key;
        FILE* f          = fopen(path.c_str(), "rb");
        if (!f) {
            fprintf(stderr, "[assets_stub] missing %s\n", path.c_str());
            return dsc;
        }
        std::vector<uint8_t> bytes;
        uint8_t buf[4096];
        size_t n;
        while ((n = fread(buf, 1, sizeof buf, f)) > 0) bytes.insert(bytes.end(), buf, buf + n);
        fclose(f);
        cache[key] = std::move(bytes);
    }
    auto& bytes      = cache[key];
    dsc.header.magic = LV_IMAGE_HEADER_MAGIC;
    dsc.header.cf    = LV_COLOR_FORMAT_RAW_ALPHA;
    dsc.data_size    = bytes.size();
    dsc.data         = bytes.data();
    return dsc;
}

}  // namespace assets

// assets.h references the embedded sound files by raw symbol name (asm labels); the
// simulator plays no sound, so give them empty definitions under the same labels.
extern const char ogg_camera_shutter_start[] asm("_binary_camera_shutter_ogg_start");
extern const char ogg_camera_shutter_end[] asm("_binary_camera_shutter_ogg_end");
extern const char ogg_new_notification_start[] asm("_binary_new_notification_ogg_start");
extern const char ogg_new_notification_end[] asm("_binary_new_notification_ogg_end");
const char ogg_camera_shutter_start[1]   = {0};
const char ogg_camera_shutter_end[1]     = {0};
const char ogg_new_notification_start[1] = {0};
const char ogg_new_notification_end[1]   = {0};
