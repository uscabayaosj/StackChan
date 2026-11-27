"""Run the camera sampler and detector mapping tests against a firmware checkout."""

import argparse
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("firmware", type=Path, help="StackChan firmware checkout")
    args = parser.parse_args()
    hal = args.firmware.resolve() / "main/hal"
    test = Path(__file__).resolve().with_suffix(".cpp")
    flags = ["-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined"]
    with tempfile.TemporaryDirectory() as tmp:
        build = Path(tmp)
        (build / "private_include").mkdir()
        (build / "private_include/esp_video.h").write_text("""
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#define V4L2_BUF_TYPE_VIDEO_CAPTURE 1
#define ESP_OK 0
struct esp_video { int unused; };
struct esp_video_buffer_element { uint8_t* buffer; uint32_t valid_size; };
struct esp_video* esp_video_device_get_object(const char*);
struct esp_video_buffer_element* esp_video_recv_element(struct esp_video*, int, int);
int esp_video_queue_element(struct esp_video*, int, struct esp_video_buffer_element*);
""")
        (build / "freertos").mkdir()
        (build / "freertos/FreeRTOS.h").write_text("#define pdMS_TO_TICKS(ms) (ms)\n")
        (build / "human_face_detect.hpp").write_text("""
#include <cassert>
#include <cstdint>
#include <vector>
namespace dl::image {
enum pix_t { DL_IMAGE_PIX_TYPE_RGB888 };
struct img_t { uint8_t* data; int width, height; pix_t pix_type; };
}
struct HumanFaceDetect {
    struct Result { std::vector<int> box; };
    std::vector<Result> results;
    const std::vector<Result>& run(const dl::image::img_t& image) {
        assert((image.width == 160 && image.height == 120) || (image.width == 320 && image.height == 240));
        assert(image.pix_type == dl::image::DL_IMAGE_PIX_TYPE_RGB888);
        return results;
    }
};
""")
        subprocess.run(["cc", "-std=c11", *flags, "-I.", "-c", hal / "board/face_luma.c",
                        "-o", "sampler.o"], cwd=build, check=True)
        subprocess.run(["c++", "-std=c++17", *flags, "-I.", "-I", hal, test, "sampler.o",
                        "-o", "face-camera-test"], cwd=build, check=True)
        subprocess.run([build / "face-camera-test"], cwd=build, check=True)


if __name__ == "__main__":
    main()
