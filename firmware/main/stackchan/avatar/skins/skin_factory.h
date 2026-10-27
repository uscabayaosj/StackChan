/*
 * Saoirse fork: picks the avatar skin at compile time.
 */
#pragma once
#include "../avatar/avatar.h"
#include "default/default.h"
#if __has_include(<sdkconfig.h>)
#include <sdkconfig.h>
#endif
#ifdef CONFIG_STACKCHAN_SKIN_SAOIRSE
#include "saoirse/saoirse.h"
#endif
#include <lvgl.h>
#include <memory>

namespace stackchan::avatar {

/** Create and init the configured skin. Callers only use the Avatar interface. */
inline std::unique_ptr<Avatar> createAvatar(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16)
{
#ifdef CONFIG_STACKCHAN_SKIN_SAOIRSE
    auto avatar = std::make_unique<SaoirseAvatar>();
#else
    auto avatar = std::make_unique<DefaultAvatar>();
#endif
    avatar->init(parent, font);
    return avatar;
}

}  // namespace stackchan::avatar
