#include "saoirse.h"
#include "../default/default.h"
#include <assets/assets.h>

using namespace uitk::lvgl_cpp;
using namespace stackchan::avatar;
using namespace stackchan::avatar::saoirse;

void SaoirseAvatar::init(lv_obj_t* parent, const lv_font_t* font)
{
    _panel = std::make_unique<Container>(parent);
    _panel->align(LV_ALIGN_CENTER, 0, 0);
    _panel->setSize(320, 240);
    _panel->setRadius(0);
    _panel->setBorderWidth(0);
    _panel->setBgColor(lv_color_hex(0xEFE6DA));
    _panel->setPadding(0, 0, 0, 0);
    _panel->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    _base_dsc = assets::get_image("saoirse_base.png");
    _base     = std::make_unique<Image>(_panel->get());
    _base->setSrc(&_base_dsc);
    _base->setAlign(LV_ALIGN_TOP_LEFT);
    _base->setPos(0, 0);

    _key_elements.leftEye  = std::make_unique<SaoirseEyes>(_panel->get(), true);
    _key_elements.rightEye = std::make_unique<SaoirseEyes>(_panel->get(), false);
    _key_elements.mouth    = std::make_unique<SaoirseMouth>(_panel->get());
    // Caption band at the top of the screen (y 0..74) so it never covers the talking mouth.
    SpeechBubbleLayout bubbleLayout;
    bubbleLayout.containerOffsetY = -83;  // centre y 37 -> container y 0..74
    bubbleLayout.arrowBelow       = true;
    _key_elements.speechBubble    = std::make_unique<DefaultSpeechBubble>(
        _panel->get(), lv_color_hex(kBubbleBg), lv_color_hex(kBubbleFg), font, bubbleLayout);
}

SaoirseAvatar::~SaoirseAvatar()
{
    // Features and decorators own LVGL children of the panel: destroy them while the
    // panel is still alive; then _base and _panel (members) are destroyed in order.
    _key_elements = KeyElements_t{};
    _decorator_pool.clear();
}

Container* SaoirseAvatar::getPanel() const
{
    return _panel ? _panel.get() : nullptr;
}
