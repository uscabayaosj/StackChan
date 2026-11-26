#pragma once

#include <display/info_card.h>
#include <lvgl.h>
#include <cstdint>
#include <functional>

// All methods and callbacks run with the LVGL lock held.
class InfoCardOverlay {
public:
    ~InfoCardOverlay();
    void Show(const InfoCard& card);
    void StartTimer(int id, uint32_t duration_ms, const std::string& name, std::function<bool(int)> cancel);
    void StopTimer(int id);
    void ReminderDue(int id, const std::string& message, bool timer);

private:
    void Clear();
    void Dismiss();
    lv_obj_t* Layout(const InfoCard& card);
    void ShowTimer();
    void TickTimer();

    lv_obj_t* root_ = nullptr;
    lv_timer_t* update_ = nullptr;
    lv_obj_t* digits_ = nullptr;
    lv_obj_t* progress_ = nullptr;
    int timer_id_ = -1;
    uint32_t timer_start_ = 0;
    uint32_t timer_duration_ = 0;
    uint32_t last_seconds_ = UINT32_MAX;
    std::string timer_name_;
    std::function<bool(int)> cancel_timer_;
    bool showing_timer_ = false;
    bool resume_timer_ = false;
};
