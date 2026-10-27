/*
 * Saoirse skin: the owner's Birman cat, traced from a photo.
 * Static art is saoirse_base.png; eyes, lids and mouth are live LVGL objects.
 */
#pragma once
#include "../../avatar/avatar.h"
#include "../../avatar/elements/feature.h"
#include <lvgl.h>
#include <smooth_lvgl.hpp>
#include <memory>

namespace stackchan::avatar {

namespace saoirse {
// Geometry (must match firmware/tools/saoirse/saoirse.svg and render_face.py)
constexpr int kEyeBox      = 66;   // eye container size (circular, corner-clipped)
constexpr int kEyeLeftX    = 71;   // top-left of the left eye box
constexpr int kEyeRightX   = 153;
constexpr int kEyeY        = 109;
constexpr int kGazeRange   = 4;    // px of iris travel for gaze = ±100
constexpr int kLidWidth    = 100;  // wider than the box so a tilted lid still covers it
constexpr int kMouthX      = 130, kMouthY = 186, kMouthW = 60, kMouthH = 40;
constexpr int kMouthOpenThreshold = 30;
// Colours
constexpr uint32_t kSocket   = 0xB4A69B;
constexpr uint32_t kRim      = 0x3A302C;
constexpr uint32_t kIris     = 0xA9CCE6;
constexpr uint32_t kShade    = 0x8FB8D8;
constexpr uint32_t kPupil    = 0x1B1716;
constexpr uint32_t kDark     = 0x3A302C;
constexpr uint32_t kTongue   = 0xFF8FA3;
constexpr uint32_t kBubbleBg = 0x3A302C;
constexpr uint32_t kBubbleFg = 0xF8F0E3;
}  // namespace saoirse

class SaoirseEyes : public Feature {
public:
    SaoirseEyes(lv_obj_t* parent, bool isLeftEye);
    ~SaoirseEyes();

    void setPosition(const uitk::Vector2i& position) override;
    void setWeight(int weight) override;
    void setRotation(int rotation) override;
    void setEmotion(const Emotion& emotion) override;
    void setVisible(bool visible) override;
    void setSize(int size) override;

private:
    void applyLid();
    void showArc(bool happy, bool sleepy);

    bool _is_left_eye = false;
    int _lid_rotation = 0;  // tenths of a degree, LVGL range 0..3600

    lv_image_dsc_t _happy_dsc{};
    lv_image_dsc_t _sleepy_dsc{};

    std::unique_ptr<uitk::lvgl_cpp::Container> _box;    // 74x74, clips children
    std::unique_ptr<uitk::lvgl_cpp::Container> _gaze;   // moves with gaze
    std::unique_ptr<uitk::lvgl_cpp::Container> _rim;
    std::unique_ptr<uitk::lvgl_cpp::Container> _iris;
    std::unique_ptr<uitk::lvgl_cpp::Container> _shade;
    std::unique_ptr<uitk::lvgl_cpp::Container> _pupil;
    std::unique_ptr<uitk::lvgl_cpp::Container> _glint1;
    std::unique_ptr<uitk::lvgl_cpp::Container> _glint2;
    std::unique_ptr<uitk::lvgl_cpp::Container> _lid;
    std::unique_ptr<uitk::lvgl_cpp::Image> _happy;
    std::unique_ptr<uitk::lvgl_cpp::Image> _sleepy;
};

class SaoirseMouth : public Feature {
public:
    explicit SaoirseMouth(lv_obj_t* parent);
    ~SaoirseMouth();

    void setPosition(const uitk::Vector2i& position) override;
    void setWeight(int weight) override;
    void setRotation(int rotation) override;
    void setEmotion(const Emotion& emotion) override;
    void setVisible(bool visible) override;

private:
    void refresh();

    Emotion _emotion = Emotion::Neutral;
    lv_image_dsc_t _pout_dsc{}, _smile_dsc{}, _frown_dsc{}, _flat_dsc{};

    std::unique_ptr<uitk::lvgl_cpp::Container> _box;
    std::unique_ptr<uitk::lvgl_cpp::Container> _oval;
    std::unique_ptr<uitk::lvgl_cpp::Container> _tongue;
    std::unique_ptr<uitk::lvgl_cpp::Image> _pout;
    std::unique_ptr<uitk::lvgl_cpp::Image> _smile;
    std::unique_ptr<uitk::lvgl_cpp::Image> _frown;
    std::unique_ptr<uitk::lvgl_cpp::Image> _flat;
};

class SaoirseAvatar : public Avatar {
public:
    ~SaoirseAvatar() override;  // destroys features/decorators before the panel (LVGL wrappers delete unconditionally)
    void init(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16) override;
    uitk::lvgl_cpp::Container* getPanel() const override;  // never null after init(): two call sites dereference it

private:
    lv_image_dsc_t _base_dsc{};
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Image> _base;
};

}  // namespace stackchan::avatar
