#include "saoirse.h"
#include <assets/assets.h>

using namespace uitk;
using namespace uitk::lvgl_cpp;
using namespace stackchan::avatar;
using namespace stackchan::avatar::saoirse;

namespace {
std::unique_ptr<Image> make_image(lv_obj_t* parent, lv_image_dsc_t& dsc, const char* name, int x, int y)
{
    dsc = assets::get_image(name);
    auto img = std::make_unique<Image>(parent);
    img->setSrc(&dsc);
    img->setAlign(LV_ALIGN_TOP_LEFT);
    img->setPos(x - kMouthX, y - kMouthY);
    return img;
}
}  // namespace

SaoirseMouth::SaoirseMouth(lv_obj_t* parent)
{
    _box = std::make_unique<Container>(parent);
    _box->setAlign(LV_ALIGN_TOP_LEFT);
    _box->setPos(kMouthX, kMouthY);
    _box->setSize(kMouthW, kMouthH);
    _box->setRadius(0);
    _box->setBorderWidth(0);
    _box->setBgOpa(LV_OPA_TRANSP);
    _box->setPadding(0, 0, 0, 0);
    _box->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    // State images, positioned by their render rects (see render_face.py).
    _pout  = make_image(_box->get(), _pout_dsc, "saoirse_pout.png", 140, 196);
    _smile = make_image(_box->get(), _smile_dsc, "saoirse_mouth_smile.png", 136, 194);
    _frown = make_image(_box->get(), _frown_dsc, "saoirse_mouth_frown.png", 138, 194);
    _flat  = make_image(_box->get(), _flat_dsc, "saoirse_mouth_flat.png", 138, 196);

    // Opening: dark oval with a tongue, sized by weight while speaking.
    _oval = std::make_unique<Container>(_box->get());
    _oval->setRadius(LV_RADIUS_CIRCLE);
    _oval->setBorderWidth(0);
    _oval->setBgColor(lv_color_hex(kDark));
    _oval->setPadding(0, 0, 0, 0);
    _oval->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    _oval->align(LV_ALIGN_CENTER, 2, 2);

    _tongue = std::make_unique<Container>(_oval->get());
    _tongue->setRadius(LV_RADIUS_CIRCLE);
    _tongue->setBorderWidth(0);
    _tongue->setBgColor(lv_color_hex(kTongue));
    _tongue->setPadding(0, 0, 0, 0);
    _tongue->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    _tongue->setAlign(LV_ALIGN_BOTTOM_MID);

    setPosition(_position);
    setWeight(0);
}

SaoirseMouth::~SaoirseMouth()
{
    _tongue.reset();
    _oval.reset();
    _flat.reset();
    _frown.reset();
    _smile.reset();
    _pout.reset();
    _box.reset();
}

void SaoirseMouth::setPosition(const Vector2i& position)
{
    Element::setPosition(position);
    _box->setPos(kMouthX + map_range(_position.x, -100, 100, -4, 4), kMouthY + map_range(_position.y, -100, 100, -4, 4));
}

void SaoirseMouth::setWeight(int weight)
{
    Feature::setWeight(weight);
    refresh();
}

void SaoirseMouth::setRotation(int rotation)
{
    Element::setRotation(rotation);  // the pout does not rotate
}

void SaoirseMouth::setEmotion(const Emotion& emotion)
{
    if (getIgnoreEmotion()) {
        return;
    }
    _emotion = emotion;
    refresh();
}

void SaoirseMouth::refresh()
{
    const bool open = _weight >= kMouthOpenThreshold;
    _oval->setHidden(!open);
    _pout->setHidden(true);
    _smile->setHidden(true);
    _frown->setHidden(true);
    _flat->setHidden(true);

    if (open) {
        const int w = map_range(_weight, kMouthOpenThreshold, 100, 18, 30);
        const int h = map_range(_weight, kMouthOpenThreshold, 100, 14, 24);
        _oval->setSize(w, h);
        _oval->align(LV_ALIGN_CENTER, 2, 2);
        _tongue->setHidden(_weight < 60);
        _tongue->setSize((w * 6) / 10, (h * 45) / 100);
        _tongue->align(LV_ALIGN_BOTTOM_MID, 0, -2);
        return;
    }
    switch (_emotion) {
        case Emotion::Happy: _smile->setHidden(false); break;
        case Emotion::Sad:   _frown->setHidden(false); break;
        case Emotion::Angry: _flat->setHidden(false); break;
        default:             _pout->setHidden(false); break;
    }
}

void SaoirseMouth::setVisible(bool visible)
{
    Element::setVisible(visible);
    _box->setHidden(!visible);
}
