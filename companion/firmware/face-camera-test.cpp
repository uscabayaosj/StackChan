// Run with python3 face-camera-test.py <firmware checkout>.
#include "face_detector.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>

extern "C" {
#include "private_include/esp_video.h"
bool read_fresh_dvp_rgb(uint8_t*, unsigned, unsigned, unsigned, unsigned);
bool read_fresh_dvp_rgb_region(uint8_t*, unsigned, unsigned, unsigned, unsigned,
                               unsigned, unsigned, unsigned, unsigned);
}

static esp_video camera{};
static esp_video_buffer_element frames[2]{};
static int received = 0, requeued = 0;

extern "C" esp_video* esp_video_device_get_object(const char* name)
{
    assert(std::strcmp(name, "DVP") == 0);
    return &camera;
}

extern "C" esp_video_buffer_element* esp_video_recv_element(esp_video* video, int type, int wait)
{
    assert(video == &camera && type == V4L2_BUF_TYPE_VIDEO_CAPTURE && wait > 0);
    return &frames[received++ % 2];
}

extern "C" int esp_video_queue_element(esp_video* video, int type, esp_video_buffer_element* frame)
{
    assert(video == &camera && type == V4L2_BUF_TYPE_VIDEO_CAPTURE);
    assert(frame == &frames[requeued++ % 2]);
    return ESP_OK;
}

static void testCapture()
{
    constexpr unsigned sw = 8, sh = 8, w = 4, h = 4;
    std::array<uint8_t, sw * sh * 2> raw{}, stale{};
    std::array<uint8_t, w * h * 3> rgb{};
    frames[0] = {stale.data(), stale.size()};
    frames[1] = {raw.data(), raw.size()};
    for (unsigned y = 0; y < sh; ++y) {
        for (unsigned x = 0; x < sw; ++x) {
            auto i = (y * sw + x) * 2;
            raw[i] = 16 + y * 16 + x * 4;
            raw[i+1] = 128;
        }
    }
    auto checkPixel = [&](unsigned x, unsigned y, int luma) {
        int gray = (298 * (luma - 16) + 128) >> 8;
        for (int channel = 0; channel < 3; ++channel) {
            assert(rgb[(y * w + x) * 3 + channel] == gray);
        }
    };

    assert(read_fresh_dvp_rgb(rgb.data(), w, h, sw, sh));
    assert(received == 2 && requeued == 2);
    for (unsigned y = 0; y < h; ++y)
        for (unsigned x = 0; x < w; ++x)
            checkPixel(x, y, 16 + 32 * y + 8 * x + 10); // 2x2 luma average

    // Native pixels in an off-center crop preserve both axes and odd-pixel luma.
    assert(read_fresh_dvp_rgb_region(rgb.data(), w, h, sw, sh, 1, 2, 2, 2));
    for (unsigned y = 0; y < h; ++y)
        for (unsigned x = 0; x < w; ++x)
            checkPixel(x, y, 16 + 16 * (4 + y) + 4 * (2 + x));

    // Distinct chroma on the first two rows exercises YUYV ordering and
    // vertical averaging. The first downsampled pixel has Y=26, U=113, V=153.
    raw[1] = 100;
    raw[3] = 160;
    raw[sw * 2 + 1] = 126;
    raw[sw * 2 + 3] = 146;
    assert(read_fresh_dvp_rgb(rgb.data(), w, h, sw, sh));
    assert(rgb[0] == 52 && rgb[1] == 0 && rgb[2] == 0);
    assert(!read_fresh_dvp_rgb_region(rgb.data(), w, h, sw, sh, 3, 2, 2, 2));
    assert(!read_fresh_dvp_rgb_region(rgb.data(), w, h, sw, sh, 0, 0, 0, 1));
    assert(received == 6 && requeued == 6);
    frames[1].valid_size = 2;
    assert(!read_fresh_dvp_rgb(rgb.data(), w, h, sw, sh));
    assert(received == 8 && requeued == 8);
}

static void testMapping()
{
    using namespace face_aim;
    HumanFaceDetect detector;
    int count = 0;
    detector.results = {{{45, 15, 65, 35}}};
    auto full = detect(detector, nullptr, 0, false, count);
    assert(count == 1 && full.x == 55 && full.y == 25 && full.size == 20);
    detector.results = {{{90, 30, 130, 70}}};
    auto native = detect(detector, nullptr, 0, false, count, 0, 0, width, height, 320, 240);
    assert(count == 1 && native.x == full.x && native.y == full.y && native.size == full.size);
    detector.results = {{{10, 10, 50, 50}}};
    auto crop = detect(detector, nullptr, 0, false, count, 40, 10, 80, 60);
    assert(count == 1 && crop.x == full.x && crop.y == full.y && crop.size == full.size);

    // The expected +/- 16 degrees selects the corresponding physical face.
    // The same two detections without acoustic support are ambiguous.
    detector.results = {{{0, 30, 20, 60}}, {{140, 40, 160, 70}}};
    for (int direction : {-1, 1}) {
        auto face = detect(detector, nullptr, direction * 16.f, true, count, 40, 30, 80, 60);
        assert(count == 2 && face.x == (direction < 0 ? 45 : 115));
        assert(face.y == (direction < 0 ? 52.5f : 57.5f) && face.size == 15);
    }
    assert(!detect(detector, nullptr, 0, false, count, 40, 30, 80, 60).size && count == 2);
    detector.results = {{{2, 20, 1, 40}}};
    assert(!detect(detector, nullptr, 0, false, count).size && count == 0);
}

static void testExposure()
{
    using namespace face_aim;
    constexpr int w=32, h=32;
    std::array<uint8_t,w*h*3> frame{};
    frame.fill(180);
    assert(!compensateExposure(frame.data(),w,h).liftedShadows);
    for (auto value : frame) assert(value==180);

    // A bright background surrounds dark pixels of two distinct intensities.
    for (int y=0; y<h; ++y) {
        for (int x=0; x<w/2; ++x) {
            auto* pixel=frame.data()+3*(y*w+x);
            const auto tone=uint8_t(x<w/4 ? 28 : 45);
            pixel[0]=tone+5;
            pixel[1]=tone;
            pixel[2]=tone-8;
        }
    }
    const auto raw=frame;
    const auto exposure=compensateExposure(frame.data(),w,h);
    assert(exposure.liftedShadows && exposure.mean<140);
    assert(frame[1]>raw[1]);
    assert(frame[3*w/4+1]-frame[1]>raw[3*w/4+1]-raw[1]);
    assert(frame[0]-frame[1]==raw[0]-raw[1] && frame[1]-frame[2]==raw[1]-raw[2]);
    assert(frame[3*(w-1)]-raw[3*(w-1)]<frame[3*w/4+1]-raw[3*w/4+1]);
}

int main()
{
    testCapture();
    testMapping();
    testExposure();
    std::puts("Camera sampling, native crops, buffer return, and face coordinate mapping passed.");
}
