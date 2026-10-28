/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once

#include <cstdint>
#include <cmath>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

class MotionDetector {
public:
    MotionDetector() = default;

    /**
     * @brief Set the shake detection threshold.
     * @param threshold Higher value needs stronger shake. Default is 4.0f.
     *                  - 2.0f: Very sensitive (light shake)
     *                  - 4.0f: Normal
     *                  - 8.0f: Hard shake required
     */
    void setShakeThreshold(float threshold)
    {
        _shake_threshold = threshold;
    }

    void update(const float& acc_x, const float& acc_y, const float& acc_z)
    {
        uint32_t now = pdTICKS_TO_MS(xTaskGetTickCount());

        // Use differential (change in acceleration) for shake detection.
        // This effectively acts as a high-pass filter and is independent of gravity orientation.
        float diff = std::abs(acc_x - _prev_acc_x) + std::abs(acc_y - _prev_acc_y) + std::abs(acc_z - _prev_acc_z);

        _prev_acc_x = acc_x;
        _prev_acc_y = acc_y;
        _prev_acc_z = acc_z;

        update_tilt(acc_x, acc_y, acc_z, now);

        // --- Shake Detection ---
        // printf("%.2f\n", diff);
        if (diff > _shake_threshold) {
            if (now - _last_shake_peak_time > 100) {       // Debounce 100ms
                if (now - _last_shake_peak_time < 1000) {  // Window 1s
                    _shake_count++;
                } else {
                    _shake_count = 1;  // Reset sequence
                }
                _last_shake_peak_time = now;

                if (_shake_count >= 3) {
                    _shake_detected = true;
                    _shake_count    = 0;
                }
            }
        }
    }

    bool isShakeDetected()
    {
        if (_shake_detected) {
            _shake_detected = false;
            return true;
        }
        return false;
    }

    /**
     * Tip-over: the IMU sits in the head, which the servos nod (about the head's left-right axis) and
     * turn (about the vertical). Neither moves gravity onto the left-right axis, so a large
     * sideways share of gravity means the body itself is lying on its side.
     */
    bool isTipOverDetected()
    {
        bool v = _tip_event;
        _tip_event = false;
        return v;
    }
    bool isUprightDetected()
    {
        bool v = _upright_event;
        _upright_event = false;
        return v;
    }
    bool isTipped() const
    {
        return _tipped;
    }
    /** Low-pass filtered gravity (m/s^2), for logging. */
    void getGravity(float& x, float& y, float& z) const
    {
        x = _gx;
        y = _gy;
        z = _gz;
    }

    // bool isPickUpDetected()
    // {
    //     if (_pickup_detected) {
    //         _pickup_detected = false;
    //         return true;
    //     }
    //     return false;
    // }

private:
    // Index of the head's left-right axis in the accelerometer frame (0 = x): x runs along the
    // screen's long side on the CoreS3. Checked against the gravity logged at boot.
    static constexpr int kSidewaysAxis       = 0;
    static constexpr float kTipShare         = 0.70f;  // |sideways| / |g| above this (~44 deg) ...
    static constexpr uint32_t kTipHoldMs     = 1200;   // ... for this long: tipped over
    static constexpr float kUprightShare     = 0.35f;  // below this (~20 deg) ...
    static constexpr uint32_t kUprightHoldMs = 1500;   // ... for this long: upright again

    void update_tilt(float ax, float ay, float az, uint32_t now)
    {
        if (!_g_init) {
            _gx = ax, _gy = ay, _gz = az;
            _g_init = true;
        }
        _gx = 0.7f * _gx + 0.3f * ax;
        _gy = 0.7f * _gy + 0.3f * ay;
        _gz = 0.7f * _gz + 0.3f * az;
        float mag = std::sqrt(_gx * _gx + _gy * _gy + _gz * _gz);
        // Only judge while roughly still (filtered magnitude near 1 g), never mid-shake.
        if (mag < 7.0f || mag > 12.5f) {
            _tip_since = _upright_since = 0;
            return;
        }
        float side  = kSidewaysAxis == 0 ? _gx : kSidewaysAxis == 1 ? _gy : _gz;
        float share = std::abs(side) / mag;
        if (!_tipped) {
            if (share > kTipShare) {
                if (_tip_since == 0) _tip_since = now;
                if (now - _tip_since >= kTipHoldMs) {
                    _tipped    = true;
                    _tip_event = true;
                    _tip_since = 0;
                }
            } else {
                _tip_since = 0;
            }
        } else {
            if (share < kUprightShare) {
                if (_upright_since == 0) _upright_since = now;
                if (now - _upright_since >= kUprightHoldMs) {
                    _tipped        = false;
                    _upright_event = true;
                    _upright_since = 0;
                }
            } else {
                _upright_since = 0;
            }
        }
    }

    bool _g_init            = false;
    float _gx = 0, _gy = 0, _gz = 0;
    bool _tipped            = false;
    bool _tip_event         = false;
    bool _upright_event     = false;
    uint32_t _tip_since     = 0;
    uint32_t _upright_since = 0;

    int _shake_count               = 0;
    uint32_t _last_shake_peak_time = 0;
    bool _shake_detected           = false;
    float _shake_threshold         = 4.0f;

    float _prev_acc_x = 0;
    float _prev_acc_y = 0;
    float _prev_acc_z = 0;
};
