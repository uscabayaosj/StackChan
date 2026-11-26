#include "info_card_overlay.h"

#include <algorithm>
#include <cstdio>

namespace {
constexpr uint32_t SURFACE = 0xEDF2F4;
constexpr uint32_t INK = 0x132A35;
constexpr uint32_t MUTED = 0x405A65;
constexpr uint32_t WHITE = 0xFFFFFF;

struct Palette { const char* label; uint32_t accent; uint32_t tint; };

Palette palette(const std::string& kind)
{
    if (kind == "weather") return {"Weather", 0x276590, 0xDBEDF9};
    if (kind == "bus") return {"Bus arrivals", 0xA3342D, 0xFBE5E1};
    if (kind == "tube") return {"Underground", 0x4D478D, 0xEDE8FA};
    if (kind == "rail") return {"Train departures", 0x185D72, 0xDAEEF3};
    if (kind == "calendar") return {"Calendar", 0x30634D, 0xDCEFE4};
    if (kind == "reminders") return {"Reminders", 0x855117, 0xFAEBD3};
    if (kind == "timer") return {"Timer", 0x30634D, 0xDCEFE4};
    return {"Live information", 0x325467, 0xE0EAF0};
}

const lv_font_t* primary_font()
{
#if LV_FONT_MONTSERRAT_48
    return &lv_font_montserrat_48;
#else
    return &lv_font_montserrat_24;
#endif
}

lv_obj_t* pane(lv_obj_t* parent, uint32_t color, int radius)
{
    auto* obj = lv_obj_create(parent);
    lv_obj_remove_style_all(obj);
    lv_obj_set_style_bg_color(obj, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(obj, radius, 0);
    lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
    return obj;
}

lv_obj_t* text(lv_obj_t* parent, const char* value, const lv_font_t* font, uint32_t color)
{
    auto* label = lv_label_create(parent);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
    lv_label_set_text(label, value);
    return label;
}

void width_and_wrap(lv_obj_t* label, int32_t width)
{
    lv_obj_set_width(label, width);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
}

void line_item(lv_obj_t* parent, const InfoCardItem& item, Palette colors)
{
    auto* row = pane(parent, WHITE, 9);
    lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_all(row, 6, 0);
    lv_obj_set_style_pad_column(row, 10, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START);
    if (!item.badge.empty()) {
        auto* badge = text(row, item.badge.c_str(), &lv_font_montserrat_16, colors.accent);
        width_and_wrap(badge, 68);
        lv_obj_set_style_pad_all(badge, 5, 0);
        lv_obj_set_style_radius(badge, 5, 0);
        lv_obj_set_style_bg_color(badge, lv_color_hex(colors.tint), 0);
        lv_obj_set_style_bg_opa(badge, LV_OPA_COVER, 0);
        lv_obj_set_style_text_align(badge, LV_TEXT_ALIGN_CENTER, 0);
    }
    auto* words = pane(row, WHITE, 0);
    lv_obj_set_size(words, 0, LV_SIZE_CONTENT);
    lv_obj_set_flex_grow(words, 1);
    lv_obj_set_flex_flow(words, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(words, 2, 0);
    width_and_wrap(text(words, item.title.c_str(), &lv_font_montserrat_16, INK), lv_pct(100));
    if (!item.detail.empty()) {
        width_and_wrap(text(words, item.detail.c_str(), &lv_font_montserrat_14, MUTED), lv_pct(100));
    }
}
}  // namespace

InfoCardOverlay::~InfoCardOverlay() { Clear(); }

void InfoCardOverlay::Clear()
{
    if (update_) lv_timer_delete(update_);
    if (root_) lv_obj_delete(root_);
    update_ = nullptr;
    root_ = nullptr;
    digits_ = nullptr;
    progress_ = nullptr;
    showing_timer_ = false;
}

void InfoCardOverlay::Dismiss()
{
    if (showing_timer_) resume_timer_ = false;
    Clear();
    if (resume_timer_ && timer_id_ >= 0) ShowTimer();
}

lv_obj_t* InfoCardOverlay::Layout(const InfoCard& card)
{
    Clear();
    const auto colors = palette(card.kind);
    root_ = pane(lv_layer_top(), SURFACE, 0);
    lv_obj_set_size(root_, lv_pct(100), lv_pct(100));
    lv_obj_align(root_, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_add_flag(root_, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_move_foreground(root_);
    lv_obj_set_flex_flow(root_, LV_FLEX_FLOW_COLUMN);

    auto* header = pane(root_, INK, 0);
    lv_obj_set_size(header, lv_pct(100), 63);
    std::string heading = colors.label;
    if (!card.source.empty()) heading += "  /  " + card.source;
    auto* kicker = text(header, heading.c_str(), &lv_font_montserrat_14, 0xB9D6DF);
    lv_obj_set_width(kicker, lv_pct(77));
    lv_label_set_long_mode(kicker, LV_LABEL_LONG_DOT);
    lv_obj_align(kicker, LV_ALIGN_TOP_LEFT, 14, 9);
    auto* title = text(header, card.title.c_str(), &lv_font_montserrat_24, WHITE);
    lv_obj_set_width(title, lv_pct(78));
    lv_label_set_long_mode(title, LV_LABEL_LONG_DOT);
    lv_obj_align(title, LV_ALIGN_BOTTOM_LEFT, 14, -8);

    auto* close = pane(header, 0x294550, 10);
    lv_obj_set_size(close, 42, 42);
    lv_obj_align(close, LV_ALIGN_RIGHT_MID, -10, 0);
    lv_obj_add_flag(close, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_bg_color(close, lv_color_hex(0x456773), LV_STATE_PRESSED);
    lv_obj_center(text(close, LV_SYMBOL_CLOSE, LV_FONT_DEFAULT, WHITE));
    lv_obj_add_event_cb(close, [](lv_event_t* e) {
        static_cast<InfoCardOverlay*>(lv_event_get_user_data(e))->Dismiss();
    }, LV_EVENT_CLICKED, this);

    auto* body = pane(root_, SURFACE, 0);
    lv_obj_set_size(body, lv_pct(100), 0);
    lv_obj_set_flex_grow(body, 1);
    lv_obj_set_flex_flow(body, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(body, 10, 0);
    lv_obj_set_style_pad_row(body, 5, 0);
    lv_obj_add_flag(body, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(body, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(body, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_bg_color(body, lv_color_hex(colors.accent), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(body, LV_OPA_60, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(body, 4, LV_PART_SCROLLBAR);
    return body;
}

void InfoCardOverlay::Show(const InfoCard& card)
{
    auto* body = Layout(card);
    const auto colors = palette(card.kind);
    if (!card.hero.empty()) {
        auto* hero = pane(body, colors.tint, 10);
        lv_obj_set_size(hero, lv_pct(100), LV_SIZE_CONTENT);
        lv_obj_set_style_pad_all(hero, 10, 0);
        lv_obj_set_style_pad_column(hero, 12, 0);
        lv_obj_set_flex_flow(hero, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(hero, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START);
        text(hero, card.hero.c_str(), primary_font(), colors.accent);
        if (!card.subtitle.empty()) {
            auto* subtitle = text(hero, card.subtitle.c_str(), &lv_font_montserrat_16, INK);
            lv_obj_set_flex_grow(subtitle, 1);
        }
    } else if (!card.subtitle.empty()) {
        width_and_wrap(text(body, card.subtitle.c_str(), &lv_font_montserrat_16, MUTED), lv_pct(100));
    }
    for (const auto& item : card.items) line_item(body, item, colors);
    update_ = lv_timer_create([](lv_timer_t* timer) {
        static_cast<InfoCardOverlay*>(lv_timer_get_user_data(timer))->Dismiss();
    }, 30000, this);
    lv_obj_add_event_cb(body, [](lv_event_t* event) {
        auto* view = static_cast<InfoCardOverlay*>(lv_event_get_user_data(event));
        if (view->update_) lv_timer_reset(view->update_);
    }, LV_EVENT_SCROLL, this);
}

void InfoCardOverlay::StartTimer(int id, uint32_t duration_ms, const std::string& name, std::function<bool(int)> cancel)
{
    timer_id_ = id;
    timer_start_ = lv_tick_get();
    timer_duration_ = duration_ms;
    timer_name_ = name;
    cancel_timer_ = std::move(cancel);
    resume_timer_ = true;
    ShowTimer();
}

void InfoCardOverlay::ShowTimer()
{
    auto* body = Layout({.kind = "timer", .title = timer_name_.empty() ? "Countdown" : timer_name_});
    showing_timer_ = true;
    last_seconds_ = UINT32_MAX;
    lv_obj_remove_flag(body, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_pad_row(body, 12, 0);
    lv_obj_set_flex_align(body, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    digits_ = text(body, "", primary_font(), INK);
    lv_obj_set_style_text_letter_space(digits_, 2, 0);
    progress_ = lv_bar_create(body);
    lv_obj_set_size(progress_, lv_pct(84), 10);
    lv_obj_set_style_bg_color(progress_, lv_color_hex(0xD3E3DC), LV_PART_MAIN);
    lv_obj_set_style_bg_color(progress_, lv_color_hex(0x30634D), LV_PART_INDICATOR);
    lv_bar_set_range(progress_, 0, 1000);
    auto* cancel = pane(body, WHITE, 9);
    lv_obj_set_size(cancel, 142, 37);
    lv_obj_add_flag(cancel, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_bg_color(cancel, lv_color_hex(0xD3E3DC), LV_STATE_PRESSED);
    lv_obj_center(text(cancel, "Cancel timer", &lv_font_montserrat_16, INK));
    lv_obj_add_event_cb(cancel, [](lv_event_t* e) {
        auto* view = static_cast<InfoCardOverlay*>(lv_event_get_user_data(e));
        const auto id = view->timer_id_;
        if (view->cancel_timer_ && view->cancel_timer_(id)) view->StopTimer(id);
    }, LV_EVENT_CLICKED, this);
    TickTimer();
    update_ = lv_timer_create([](lv_timer_t* timer) {
        static_cast<InfoCardOverlay*>(lv_timer_get_user_data(timer))->TickTimer();
    }, 100, this);
}

void InfoCardOverlay::TickTimer()
{
    const uint32_t remaining = timer_duration_ - std::min(timer_duration_, lv_tick_elaps(timer_start_));
    const uint32_t seconds = (remaining + 999) / 1000;
    if (seconds != last_seconds_) {
        last_seconds_ = seconds;
        char clock[16];
        if (seconds >= 3600) {
            std::snprintf(clock, sizeof(clock), "%02u:%02u:%02u", unsigned(seconds / 3600), unsigned(seconds / 60 % 60), unsigned(seconds % 60));
        } else {
            std::snprintf(clock, sizeof(clock), "%02u:%02u", unsigned(seconds / 60), unsigned(seconds % 60));
        }
        lv_label_set_text(digits_, clock);
    }
    const int fill = timer_duration_ ? static_cast<int>(uint64_t(remaining) * 1000 / timer_duration_) : 0;
    lv_bar_set_value(progress_, fill, LV_ANIM_OFF);
}

void InfoCardOverlay::StopTimer(int id)
{
    if (timer_id_ != id) return;
    if (showing_timer_) Clear();
    timer_id_ = -1;
    resume_timer_ = false;
}

void InfoCardOverlay::ReminderDue(int id, const std::string& message, bool timer)
{
    if (timer_id_ == id) StopTimer(id);
    Show({.kind = timer ? "timer" : "reminders", .title = timer ? "Time's up" : "Reminder due",
          .hero = timer ? "00:00" : "",
          .items = {{.title = message}}});
}
