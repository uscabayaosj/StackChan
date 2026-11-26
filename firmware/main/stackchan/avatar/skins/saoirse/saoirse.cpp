#include "saoirse.h"
#include "../default/default.h"
#include <algorithm>
#include <cmath>

using namespace uitk;
using namespace uitk::lvgl_cpp;
using namespace stackchan::avatar;

namespace {

constexpr int kScreenWidth = 320;
constexpr int kScreenHeight = 240;
constexpr uint32_t kPhosphorGreen = 0x79F75B;
constexpr uint32_t kDimGreen = 0x509740;
constexpr uint32_t kShutterDurationMs = 520;

void drawDisc(lv_layer_t* layer, int x, int y, int radius, uint32_t color, int border = 0)
{
    if (radius <= 0) {
        return;
    }
    lv_draw_rect_dsc_t disc;
    lv_draw_rect_dsc_init(&disc);
    disc.radius = LV_RADIUS_CIRCLE;
    disc.bg_color = lv_color_hex(color);
    disc.border_color = lv_color_hex(kPhosphorGreen);
    disc.border_width = border;
    const lv_area_t bounds{x - radius, y - radius, x + radius - 1, y + radius - 1};
    lv_draw_rect(layer, &disc, &bounds);
}

int radialOffset(int radius, int degrees)
{
    return (radius * lv_trigo_sin(degrees)) / LV_TRIGO_SIN_MAX;
}

void drawLens(lv_layer_t* layer, int x, int y, int opening)
{
    drawDisc(layer, x, y, 46, 0x102C17, 3);
    drawDisc(layer, x, y, 39, 0x58B846);

    const int aperture = 27 * opening / 100;
    const int rotation = 28 * (100 - opening) / 100;
    for (int blade = 0; blade < 6; ++blade) {
        const int angle = blade * 60 + rotation;
        lv_draw_line_dsc_t seam;
        lv_draw_line_dsc_init(&seam);
        seam.color = lv_color_hex(0x102C17);
        seam.width = 2;
        seam.p1.x = x + radialOffset(38, angle + 90);
        seam.p1.y = y + radialOffset(38, angle);
        seam.p2.x = x + radialOffset(aperture, angle + 133);
        seam.p2.y = y + radialOffset(aperture, angle + 43);
        lv_draw_line(layer, &seam);
    }
    drawDisc(layer, x, y, aperture, 0x000000);
}

class PhosphorEye : public Feature {
public:
    PhosphorEye(lv_obj_t* parent, bool left, const ConversationActivity& activity, Feature& speechPulse)
        : _left(left), _activity(activity), _speech_pulse(speechPulse)
    {
        Feature::setWeight(100);
        _block = lv_obj_create(parent);
        lv_obj_remove_style_all(_block);
        lv_obj_remove_flag(_block, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_remove_flag(_block, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_style_bg_color(_block, lv_color_hex(kPhosphorGreen), 0);
        lv_obj_set_style_bg_opa(_block, LV_OPA_COVER, 0);
        lv_obj_set_style_transform_pivot_x(_block, lv_pct(50), 0);
        lv_obj_set_style_transform_pivot_y(_block, lv_pct(50), 0);

        _pose = targetPose();
        render();
        _timer = lv_timer_create([](lv_timer_t* timer) {
            static_cast<PhosphorEye*>(lv_timer_get_user_data(timer))->animate();
        }, 33, this);
    }

    ~PhosphorEye() override
    {
        lv_timer_delete(_timer);
        lv_obj_delete(_block);
    }

    void setVisible(bool visible) override
    {
        Element::setVisible(visible);
        lv_obj_set_flag(_block, LV_OBJ_FLAG_HIDDEN, !visible);
    }

    void setEmotion(const Emotion& emotion) override
    {
        if (getIgnoreEmotion()) {
            return;
        }

        _emotion = emotion;
        setRotation(0);
        switch (emotion) {
            case Emotion::Neutral: setWeight(100); break;
            case Emotion::Happy:    setWeight(54); break;
            case Emotion::Angry:    setWeight(49); break;
            case Emotion::Sad:      setWeight(50); break;
            case Emotion::Doubt:    setWeight(_left ? 100 : 44); break;
            case Emotion::Sleepy:   setWeight(0); break;
        }

        lv_obj_set_style_bg_color(_block, lv_color_hex(emotion == Emotion::Sleepy ? kDimGreen : kPhosphorGreen), 0);
    }

    Emotion getEmotion() const override { return _emotion; }

private:
    struct Pose {
        float x, y, width, height, tilt;
    };

    Pose targetPose() const
    {
        int width = 96 + _size / 8;
        int height = 116 * _weight / 100;
        int x = (_left ? 99 : 221) + std::clamp(_position.x * 3 / 4, -18, 18);
        int y = 122 + std::clamp(_position.y / 2, -24, 24);
        int tilt = 0;
        const int mirror = _left ? 1 : -1;

        switch (_emotion) {
            case Emotion::Neutral: break;
            case Emotion::Happy:   width += 4; y -= 24; tilt = -105 * mirror; break;
            case Emotion::Angry:   width += 1; y -= 9; tilt = 170 * mirror; break;
            case Emotion::Sad:     width -= 14; y += 23; tilt = -155 * mirror; break;
            case Emotion::Doubt:   y += _left ? -6 : 23; tilt = _left ? -35 : 100; break;
            case Emotion::Sleepy:  width -= 24; y += 42; break;
        }

        switch (_activity) {
            case ConversationActivity::Idle: {
                const int pulse = _speech_pulse.getWeight();
                height += pulse / 8;
                y -= pulse / 12;
                break;
            }
            case ConversationActivity::Listening:
                // Upright, symmetrical and focused.
                x = _left ? 101 : 219;
                y = 109;
                width = 76;
                height = 126;
                tilt = 0;
                break;
            case ConversationActivity::Thinking: {
                // Look up and alternate which eye squints on each glance.
                const bool lookRight = (lv_tick_elaps(_activity_since) / 1100) % 2 == 0;
                const bool raised = _left != lookRight;
                x = (_left ? 101 : 219) + (lookRight ? 23 : -23);
                y = raised ? 84 : 105;
                width = raised ? 74 : 88;
                height = raised ? 39 : 73;
                tilt = lookRight ? -95 : 95;
                break;
            }
            case ConversationActivity::Talking: {
                // Wide, squat eyes that stretch on voiced beats.
                const int pulse = _speech_pulse.getWeight();
                width = 102 - pulse / 12;
                height = 48 + pulse * 44 / 100 - (100 - _weight) / 7;
                y -= pulse / 8;
                tilt /= 2;
                break;
            }
        }

        // BlinkModifier reserves weight 25 for the closed frame.
        if (_weight <= 25) {
            height = _emotion == Emotion::Sleepy ? 8 : 7;
            tilt = _emotion == Emotion::Sleepy ? 0 : tilt / 2;
            width -= 10;
        }

        const int externalTilt = _rotation > 1800 ? _rotation - 3600 : _rotation;
        tilt = std::clamp(tilt + externalTilt, -180, 180);

        // Allow room for the rotated edge so the two blocks stay inside the
        // display and keep their gap, even when looking to an edge.
        const int tiltMarginX = height * std::abs(tilt) / 1000;
        width = std::min(width, 2 * (std::min(x, kScreenWidth - x) - 4 - tiltMarginX));
        width = std::min(width, 114 - 2 * tiltMarginX);
        const int yMargin = height / 2 + width * std::abs(tilt) / 1000 + 4;
        y = std::clamp(y, yMargin, kScreenHeight - yMargin);

        return {float(x), float(y), float(width), float(height), float(tilt)};
    }

    void animate()
    {
        if (!getVisible()) {
            return;
        }

        if (_previous_activity != _activity) {
            _previous_activity = _activity;
            _activity_since = lv_tick_get();
        }

        const Pose target = targetPose();
        auto ease = [](float from, float to, float factor) {
            return std::abs(to - from) < 0.5f ? to : from + (to - from) * factor;
        };

        // Make the downstroke snappy and give the opening a softer follow-through.
        const float heightSpeed = target.height <= 8 ? 0.82f : 0.53f;
        _pose.x      = ease(_pose.x, target.x, 0.44f);
        _pose.y      = ease(_pose.y, target.y, 0.44f);
        _pose.width  = ease(_pose.width, target.width, 0.44f);
        _pose.height = ease(_pose.height, target.height, heightSpeed);
        _pose.tilt   = ease(_pose.tilt, target.tilt, 0.48f);
        render();
    }

    void render()
    {
        const int width = std::lround(_pose.width);
        const int height = std::lround(_pose.height);
        const int x = std::lround(_pose.x - width / 2.0f);
        const int y = std::lround(_pose.y - height / 2.0f);
        const int tilt = std::lround(_pose.tilt);

        if (width != _drawn_width || height != _drawn_height) {
            lv_obj_set_size(_block, width, height);
            lv_obj_set_style_radius(_block, std::min({13, width / 6, height / 2}), 0);
            _drawn_width = width;
            _drawn_height = height;
        }
        if (tilt != _drawn_tilt) {
            lv_obj_set_style_transform_rotation(_block, tilt, 0);
            _drawn_tilt = tilt;
        }
        if (x != _drawn_x || y != _drawn_y) {
            lv_obj_set_pos(_block, x, y);
            _drawn_x = x;
            _drawn_y = y;
        }
    }

    const bool _left;
    const ConversationActivity& _activity;
    Feature& _speech_pulse;
    ConversationActivity _previous_activity = ConversationActivity::Idle;
    uint32_t _activity_since = 0;
    Emotion _emotion = Emotion::Neutral;
    lv_obj_t* _block = nullptr;
    lv_timer_t* _timer = nullptr;
    Pose _pose{};
    int _drawn_width = 0;
    int _drawn_height = 0;
    int _drawn_x = -1;
    int _drawn_y = -1;
    int _drawn_tilt = 0;
};

}  // namespace

void SaoirseAvatar::init(lv_obj_t* parent, const lv_font_t* font)
{
    _panel = std::make_unique<Container>(parent);
    _panel->align(LV_ALIGN_CENTER, 0, 0);
    _panel->setSize(kScreenWidth, kScreenHeight);
    _panel->setRadius(0);
    _panel->setBorderWidth(0);
    _panel->setBgColor(lv_color_black());
    _panel->setBgOpa(LV_OPA_COVER);
    _panel->setPadding(0, 0, 0, 0);
    _panel->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    // The avatar API still supplies a mouth weight for speech animation.
    // The eyes consume that signal without drawing a mouth.
    _key_elements.mouth = std::make_unique<Feature>();
    _key_elements.leftEye = std::make_unique<PhosphorEye>(_panel->get(), true, _activity, *_key_elements.mouth);
    _key_elements.rightEye = std::make_unique<PhosphorEye>(_panel->get(), false, _activity, *_key_elements.mouth);

    _shutter_layer = lv_obj_create(_panel->get());
    lv_obj_remove_style_all(_shutter_layer);
    lv_obj_remove_flag(_shutter_layer, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(_shutter_layer, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_size(_shutter_layer, kScreenWidth, kScreenHeight);
    lv_obj_set_style_bg_color(_shutter_layer, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(_shutter_layer, LV_OPA_COVER, 0);
    lv_obj_add_flag(_shutter_layer, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(_shutter_layer, [](lv_event_t* event) {
        auto* avatar = static_cast<SaoirseAvatar*>(lv_event_get_user_data(event));
        avatar->drawPhotoShutter(lv_event_get_layer(event));
    }, LV_EVENT_DRAW_MAIN, this);

    _key_elements.speechBubble = std::make_unique<DefaultSpeechBubble>(
        _panel->get(), lv_color_black(), lv_color_hex(0xC7F5BC), font);
}

uint32_t SaoirseAvatar::playPhotoShutter()
{
    _shutter_frame_ms = 0;
    lv_obj_remove_flag(_shutter_layer, LV_OBJ_FLAG_HIDDEN);

    lv_anim_t shutter;
    lv_anim_init(&shutter);
    lv_anim_set_var(&shutter, this);
    lv_anim_set_values(&shutter, 0, kShutterDurationMs);
    lv_anim_set_duration(&shutter, kShutterDurationMs);
    lv_anim_set_exec_cb(&shutter, [](void* target, int32_t frameMs) {
        auto* avatar = static_cast<SaoirseAvatar*>(target);
        avatar->_shutter_frame_ms = frameMs;
        lv_area_t area;
        lv_obj_get_coords(avatar->_shutter_layer, &area);
        const lv_area_t lenses{area.x1 + 53, area.y1 + 66, area.x1 + 266, area.y1 + 157};
        lv_obj_invalidate_area(avatar->_shutter_layer, &lenses);
    });
    lv_anim_set_completed_cb(&shutter, [](lv_anim_t* animation) {
        auto* avatar = static_cast<SaoirseAvatar*>(animation->var);
        lv_obj_add_flag(avatar->_shutter_layer, LV_OBJ_FLAG_HIDDEN);
    });
    lv_anim_start(&shutter);
    return kShutterDurationMs;
}

void SaoirseAvatar::drawPhotoShutter(lv_layer_t* layer) const
{
    // Hold the open lens briefly, close the blades, then open them again.
    const int frameMs = _shutter_frame_ms;
    const int closing = std::clamp((170 - frameMs) * 100 / 90, 0, 100);
    const int reopening = std::clamp((frameMs - 270) * 100 / 170, 0, 100);
    const int opening = std::max(closing, reopening);
    lv_area_t area;
    lv_obj_get_coords(_shutter_layer, &area);
    drawLens(layer, area.x1 + 99, area.y1 + 112, opening);
    drawLens(layer, area.x1 + 221, area.y1 + 112, opening);
}

SaoirseAvatar::~SaoirseAvatar()
{
    lv_anim_delete(this, nullptr);
    _key_elements = KeyElements_t{};
    _decorator_pool.clear();
}

Container* SaoirseAvatar::getPanel() const
{
    return _panel.get();
}
