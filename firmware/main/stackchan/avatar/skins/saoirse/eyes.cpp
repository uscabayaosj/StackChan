#include "saoirse.h"
#include <assets/assets.h>

using namespace uitk;
using namespace uitk::lvgl_cpp;
using namespace stackchan::avatar;
using namespace stackchan::avatar::saoirse;

namespace {

std::unique_ptr<Container> make_circle(lv_obj_t* parent, int diameter, uint32_t color, int x, int y, lv_opa_t opa = LV_OPA_COVER)
{
    auto c = std::make_unique<Container>(parent);
    c->setSize(diameter, diameter);
    c->setRadius(LV_RADIUS_CIRCLE);
    c->setBorderWidth(0);
    c->setBgColor(lv_color_hex(color));
    c->setBgOpa(opa);
    c->setPadding(0, 0, 0, 0);
    c->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    c->align(LV_ALIGN_CENTER, x, y);
    return c;
}

// The arc PNGs were cropped from the full canvas at x = 67 (left) / 149 (right), 74 px wide;
// the circular box starts 4 px further right, so shift them back by 4.
int kEyeLeftX_or_RightX(bool isLeftEye)
{
    return isLeftEye ? kEyeLeftX : kEyeRightX;
}

int wrap_rotation(int tenths)
{
    tenths %= 3600;
    if (tenths < 0) tenths += 3600;
    return tenths;
}

}  // namespace

SaoirseEyes::SaoirseEyes(lv_obj_t* parent, bool isLeftEye) : _is_left_eye(isLeftEye)
{
    // Clipping box at the eye socket. Children outside it (the raised lid) are hidden.
    _box = std::make_unique<Container>(parent);
    _box->setAlign(LV_ALIGN_TOP_LEFT);
    _box->setPos(isLeftEye ? kEyeLeftX : kEyeRightX, kEyeY);
    _box->setSize(kEyeBox, kEyeBox);
    _box->setRadius(LV_RADIUS_CIRCLE);  // the socket is a disc: clip lids and gaze to it
    lv_obj_set_style_clip_corner(_box->get(), true, 0);
    _box->setBorderWidth(0);
    _box->setBgOpa(LV_OPA_TRANSP);
    _box->setPadding(0, 0, 0, 0);
    _box->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    // Gaze group: everything that moves when she looks around.
    _gaze = std::make_unique<Container>(_box->get());
    _gaze->setAlign(LV_ALIGN_TOP_LEFT);
    _gaze->setPos(0, 0);
    _gaze->setSize(kEyeBox, kEyeBox);
    _gaze->setRadius(0);
    _gaze->setBorderWidth(0);
    _gaze->setBgOpa(LV_OPA_TRANSP);
    _gaze->setPadding(0, 0, 0, 0);
    _gaze->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    _rim    = make_circle(_gaze->get(), 58, kRim, 0, 0);
    _iris   = make_circle(_gaze->get(), 52, kIris, 0, 0);
    _shade  = make_circle(_gaze->get(), 40, kShade, 0, 4, LV_OPA_60);
    _pupil  = make_circle(_gaze->get(), 24, kPupil, 0, 2);
    _glint1 = make_circle(_gaze->get(), 14, 0xFFFFFF, -8, -9);
    _glint2 = make_circle(_gaze->get(), 8, 0xFFFFFF, 7, 7);

    // Lid: socket-coloured, pivots at its bottom centre so it can tilt for emotions.
    _lid = std::make_unique<Container>(_box->get());
    _lid->setAlign(LV_ALIGN_TOP_LEFT);
    _lid->setSize(kLidWidth, kEyeBox);
    _lid->setRadius(0);
    _lid->setBorderWidth(0);
    _lid->setBgColor(lv_color_hex(kSocket));
    _lid->setBgOpa(LV_OPA_COVER);
    _lid->setPadding(0, 0, 0, 0);
    _lid->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    _lid->setTransformPivot(kLidWidth / 2, kEyeBox);

    // Emotion arcs drawn over the closed lid.
    _happy_dsc  = assets::get_image(isLeftEye ? "saoirse_eye_happy_l.png" : "saoirse_eye_happy_r.png");
    _sleepy_dsc = assets::get_image(isLeftEye ? "saoirse_eye_sleepy_l.png" : "saoirse_eye_sleepy_r.png");
    _happy = std::make_unique<Image>(_box->get());
    _happy->setSrc(&_happy_dsc);
    _happy->setAlign(LV_ALIGN_TOP_LEFT);
    _happy->setPos(67 - kEyeLeftX_or_RightX(isLeftEye), 118 - kEyeY);
    _sleepy = std::make_unique<Image>(_box->get());
    _sleepy->setSrc(&_sleepy_dsc);
    _sleepy->setAlign(LV_ALIGN_TOP_LEFT);
    _sleepy->setPos(67 - kEyeLeftX_or_RightX(isLeftEye), 124 - kEyeY);
    showArc(false, false);

    setSize(0);
    setWeight(100);
    setPosition(_position);
    setRotation(0);
}

SaoirseEyes::~SaoirseEyes()
{
    _happy.reset();
    _sleepy.reset();
    _lid.reset();
    _glint2.reset();
    _glint1.reset();
    _pupil.reset();
    _shade.reset();
    _iris.reset();
    _rim.reset();
    _gaze.reset();
    _box.reset();
}

void SaoirseEyes::setPosition(const Vector2i& position)
{
    Element::setPosition(position);
    const int dx = map_range(_position.x, -100, 100, -kGazeRange, kGazeRange);
    const int dy = map_range(_position.y, -100, 100, -kGazeRange, kGazeRange);
    _gaze->setPos(dx, dy);
}

void SaoirseEyes::applyLid()
{
    // weight 100 = open: lid fully above the box (clipped). weight 0 = closed: lid covers the box.
    const int y = -kEyeBox + map_range(100 - _weight, 0, 100, 0, kEyeBox);
    _lid->setPos(-(kLidWidth - kEyeBox) / 2, y);
    _lid->setRotation(_lid_rotation);
}

void SaoirseEyes::setWeight(int weight)
{
    Feature::setWeight(weight);
    applyLid();
}

void SaoirseEyes::setRotation(int rotation)
{
    Element::setRotation(rotation);
    _lid_rotation = wrap_rotation(rotation);
    applyLid();
}

void SaoirseEyes::showArc(bool happy, bool sleepy)
{
    _happy->setHidden(!happy);
    _sleepy->setHidden(!sleepy);
}

void SaoirseEyes::setEmotion(const Emotion& emotion)
{
    if (getIgnoreEmotion()) {
        return;
    }
    // tilt > 0 lowers the inner (nose-side) corner of the lid; mirrored per eye.
    auto apply = [this](int weight, int tilt_tenths, bool happy, bool sleepy) {
        setRotation(_is_left_eye ? tilt_tenths : -tilt_tenths);
        setWeight(weight);
        showArc(happy, sleepy);
    };
    switch (emotion) {
        case Emotion::Neutral: apply(100, 0, false, false); break;
        case Emotion::Happy:   apply(0, 0, true, false); break;
        case Emotion::Angry:   apply(45, 180, false, false); break;
        case Emotion::Sad:     apply(45, -180, false, false); break;
        case Emotion::Doubt:   apply(_is_left_eye ? 100 : 50, 0, false, false); break;
        case Emotion::Sleepy:  apply(0, 0, false, true); break;
        default: break;
    }
}

void SaoirseEyes::setVisible(bool visible)
{
    Element::setVisible(visible);
    _box->setHidden(!visible);
}

void SaoirseEyes::setSize(int size)
{
    Feature::setSize(size);
    // -100..100 -> pupil 18..34 px: wide pupils when excited, pinned when annoyed.
    const int pupil = map_range(_size, -100, 100, 16, 30);
    _pupil->setSize(pupil, pupil);
}
