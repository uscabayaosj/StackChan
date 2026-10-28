/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "drivers/Si12T/Si12T.h"
#include "board/hal_bridge.h"
#include <mooncake_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

static const std::string_view _tag = "HAL-HeadTouch";

// 触摸状态
enum class TouchState { IDLE, TOUCHED, SWIPING };

// 配置参数
struct TouchConfig {
    uint8_t touch_threshold = 1;
    // Saoirse: 40 -> 25 so a shorter stroke counts (position runs -100..100 across the three pads).
    int16_t swipe_threshold = 25;
    // A hand resting on her head this long counts as petting, without any stroke.
    uint32_t hold_pet_ms = 450;
    // While stroking, each further move of swipe_threshold (at most this often) is another stroke.
    uint32_t restroke_ms = 300;
    // A tap is a touch released this quickly without a stroke; two within double_tap_ms make a double tap.
    // Electrical noise produces touches of at most ~150 ms (measured untouched); a stroke only counts once
    // contact has lasted this long, so a noise blip landing unevenly on the pads can't read as a stroke.
    uint32_t min_stroke_contact_ms = 200;
    uint32_t tap_max_ms    = 280;
    uint32_t double_tap_ms = 450;
};

// 触摸数据
struct TouchData {
    uint8_t intensity[3];
    uint32_t timestamp;

    // 计算位置（返回-100到100的整数）
    int16_t get_position() const
    {
        uint16_t total = intensity[0] + intensity[1] + intensity[2];
        if (total == 0) return 0;

        int32_t weighted = intensity[0] * (-100) + intensity[1] * 0 + intensity[2] * 100;
        return static_cast<int16_t>(weighted / total);
    }

    uint8_t get_max_intensity() const
    {
        uint8_t max_val = intensity[0];
        if (intensity[1] > max_val) max_val = intensity[1];
        if (intensity[2] > max_val) max_val = intensity[2];
        return max_val;
    }

    // Hysteresis. With the AI app's radio running, this robot's pads show phantom touches at the
    // chip's weakest level only (intensity 1: 185 of 185 noise readings in 3.5 min hands-off, while a
    // finger reads 3). A touch therefore starts only at intensity 2+, then lasts while any pad stays at
    // 1+. Verified on the robot: 12 real touches registered, then 0 phantom touches in ~5 min untouched.
    bool starts_touch() const
    {
        return get_max_intensity() >= 2;
    }
    bool is_touched() const
    {
        return get_max_intensity() >= 1;
    }
};

// 手势识别器类
class GestureRecognizer {
public:
    GestureRecognizer() : current_state(TouchState::IDLE), initial_position(0)
    {
    }

    // 更新状态机，返回识别到的手势
    HeadPetGesture update(const TouchData& data)
    {
        HeadPetGesture gesture = HeadPetGesture::None;
        const uint32_t now     = pdTICKS_TO_MS(data.timestamp);

        switch (current_state) {
            case TouchState::IDLE:
                if (data.starts_touch()) {
                    current_state    = TouchState::TOUCHED;
                    initial_position = data.get_position();
                    touch_started_ms = now;
                    gesture          = HeadPetGesture::Press;
                }
                break;

            case TouchState::TOUCHED:
                if (!data.is_touched()) {
                    current_state = TouchState::IDLE;
                    gesture       = HeadPetGesture::Release;
                    if (now - touch_started_ms <= config.tap_max_ms) {
                        if (last_tap_ms != 0 && now - last_tap_ms <= config.double_tap_ms) {
                            gesture     = HeadPetGesture::DoubleTap;
                            last_tap_ms = 0;
                        } else {
                            last_tap_ms = now;
                        }
                    }
                } else {
                    int16_t current_pos = data.get_position();
                    int16_t delta       = current_pos - initial_position;
                    const bool long_enough = now - touch_started_ms >= config.min_stroke_contact_ms;
                    if (long_enough && (delta > config.swipe_threshold || delta < -config.swipe_threshold)) {
                        gesture = delta > 0 ? HeadPetGesture::SwipeForward : HeadPetGesture::SwipeBackward;
                    } else if (now - touch_started_ms >= config.hold_pet_ms) {
                        gesture = HeadPetGesture::SwipeForward;  // a resting hand is petting too
                    }
                    if (gesture != HeadPetGesture::None) {
                        current_state     = TouchState::SWIPING;
                        last_stroke_pos   = current_pos;
                        last_stroke_ms    = now;
                        last_tap_ms       = 0;
                    }
                }
                break;

            case TouchState::SWIPING:
                if (!data.is_touched()) {
                    current_state = TouchState::IDLE;
                    gesture       = HeadPetGesture::Release;
                } else {
                    // Rubbing back and forth keeps producing strokes, so she keeps reacting.
                    int16_t current_pos = data.get_position();
                    int16_t delta       = current_pos - last_stroke_pos;
                    if ((delta > config.swipe_threshold || delta < -config.swipe_threshold) &&
                        now - last_stroke_ms >= config.restroke_ms) {
                        gesture         = delta > 0 ? HeadPetGesture::SwipeForward : HeadPetGesture::SwipeBackward;
                        last_stroke_pos = current_pos;
                        last_stroke_ms  = now;
                    }
                }
                break;
        }

        return gesture;
    }

    void set_config(const TouchConfig& cfg)
    {
        config = cfg;
    }

private:
    TouchConfig config;
    TouchState current_state;
    int16_t initial_position;
    uint32_t touch_started_ms = 0;
    int16_t last_stroke_pos   = 0;
    uint32_t last_stroke_ms   = 0;
    uint32_t last_tap_ms      = 0;
};

static void _head_touch_update_task(void* param)
{
    mclog::tagInfo(_tag, "start update task");

    si12t_handle_t si12t = (si12t_handle_t)param;
    uint8_t touch_result = 0;
    TouchData data;

    GestureRecognizer recognizer;
    HeadPetGesture gesture;

    vTaskDelay(pdMS_TO_TICKS(200));

    while (1) {
        // Read data
        si12t_read_touch_result(si12t, &touch_result);
        si12t_parse_touch_result_to(touch_result, data.intensity);
        data.timestamp = xTaskGetTickCount();

        // Update and fire event
        gesture = recognizer.update(data);
        if (gesture != HeadPetGesture::None) {
            GetHAL().onHeadPetGesture.emit(gesture);
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

void Hal::head_touch_init()
{
    mclog::tagInfo(_tag, "init");

    auto i2c_bus = hal_bridge::board_get_i2c_bus();

    si12t_config_t si12t_cfg = {
        .i2c_bus  = i2c_bus,
        .dev_addr = SI12T_GND_ADDRESS,
    };
    static si12t_handle_t si12t;
    si12t_init(&si12t_cfg, &si12t);
    // Level 3 as shipped. Lower codes are lower capacitance thresholds (Si12T datasheet 12.2.1), but on
    // this robot levels 1 and 2 pick up a periodic electrical pulse (~every 1.15 s) as firm touches on
    // all three pads: 104 and 68 false touches in ~80 s untouched, vs 7 faint single-pad blips at level 3.
    // Petting is made more responsive in the gesture recognizer instead (shorter strokes, resting hand).
    si12t_setup(si12t, SI12T_TYPE_LOW, SI12T_SENSITIVITY_LEVEL_3);

    // xTaskCreateWithCaps(_head_touch_update_task, "headtouch", 1024 * 6, si12t, 2, NULL, MALLOC_CAP_SPIRAM);
    xTaskCreatePinnedToCoreWithCaps(_head_touch_update_task, "headtouch", 1024 * 6, si12t, 2, NULL, 1,
                                    MALLOC_CAP_SPIRAM);
}
