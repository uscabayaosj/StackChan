/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include "../modifiable.h"
#include <hal/hal.h>
#include <array>
#include <cstdint>
#include <functional>
#include <vector>

namespace stackchan {

/**
 * @brief Steps both neon light bars through a list of colours, then hands the lights back
 * (`onDone` restores whatever colour the current state wants) and destroys itself.
 * Used for Saoirse's happy flash.
 */
class NeonFlashModifier : public Modifier {
public:
    using Rgb = std::array<uint8_t, 3>;

    NeonFlashModifier(std::vector<Rgb> colors, uint32_t stepMs, std::function<void()> onDone)
        : _colors(std::move(colors)), _step_ms(stepMs), _on_done(std::move(onDone))
    {
        _next_tick = GetHAL().millis();  // first colour on the first update
    }

    void _update(Modifiable& stackchan) override
    {
        uint32_t now = GetHAL().millis();
        if (now < _next_tick) {
            return;
        }
        if (_index >= _colors.size()) {
            if (_on_done) {
                _on_done();
            }
            requestDestroy();
            return;
        }
        const auto& c = _colors[_index++];
        // Short fade so each step reads as a flash, not a slow blend.
        stackchan.leftNeonLight().setDuration(0.08f);
        stackchan.rightNeonLight().setDuration(0.08f);
        stackchan.leftNeonLight().setColor(c[0], c[1], c[2]);
        stackchan.rightNeonLight().setColor(c[0], c[1], c[2]);
        _next_tick = now + _step_ms;
    }

private:
    std::vector<Rgb> _colors;
    uint32_t _step_ms;
    std::function<void()> _on_done;
    size_t _index        = 0;
    uint32_t _next_tick  = 0;
};

/**
 * @brief Delight lights: while Saoirse is being stroked (head-pet swipes), both light bars cycle
 * through a rainbow; shortly after the hand lifts, `onDone` hands the lights back to the state colour.
 */
class PetGlowModifier : public Modifier {
public:
    explicit PetGlowModifier(std::function<void()> onDone, uint32_t stepMs = 170, uint32_t lingerMs = 700)
        : _on_done(std::move(onDone)), _step_ms(stepMs), _linger_ms(lingerMs)
    {
        _signal_connection = GetHAL().onHeadPetGesture.connect([this](HeadPetGesture g) {
            if (g == HeadPetGesture::SwipeForward || g == HeadPetGesture::SwipeBackward) {
                _event_stroke = true;
            } else if (g == HeadPetGesture::Release) {
                _event_release = true;
            }
        });
    }

    ~PetGlowModifier()
    {
        GetHAL().onHeadPetGesture.disconnect(_signal_connection);
    }

    void _update(Modifiable& stackchan) override
    {
        uint32_t now = GetHAL().millis();
        if (_event_stroke) {
            _event_stroke = false;
            if (!_active) {
                _active    = true;
                _next_step = now;
            }
            _stop_at = 0;  // still being stroked
        }
        if (_event_release) {
            _event_release = false;
            if (_active) _stop_at = now + _linger_ms;
        }
        if (!_active) return;
        if (_stop_at != 0 && now >= _stop_at) {
            _active  = false;
            _stop_at = 0;
            if (_on_done) _on_done();
            return;
        }
        if (now >= _next_step) {
            static const uint8_t kRainbow[][3] = {
                {150, 0, 40}, {150, 50, 0}, {130, 110, 0}, {0, 140, 30},
                {0, 110, 120}, {20, 40, 160}, {100, 0, 150}, {150, 20, 100},
            };
            const auto& c = kRainbow[_index++ % (sizeof(kRainbow) / sizeof(kRainbow[0]))];
            stackchan.leftNeonLight().setDuration(0.12f);
            stackchan.rightNeonLight().setDuration(0.12f);
            stackchan.leftNeonLight().setColor(c[0], c[1], c[2]);
            // The right bar runs a step ahead, so the colours chase across her head.
            const auto& d = kRainbow[_index % (sizeof(kRainbow) / sizeof(kRainbow[0]))];
            stackchan.rightNeonLight().setColor(d[0], d[1], d[2]);
            _next_step = now + _step_ms;
        }
    }

private:
    std::function<void()> _on_done;
    uint32_t _step_ms;
    uint32_t _linger_ms;
    int _signal_connection;
    volatile bool _event_stroke  = false;
    volatile bool _event_release = false;
    bool _active                 = false;
    uint32_t _stop_at            = 0;
    uint32_t _next_step          = 0;
    size_t _index                = 0;
};

}  // namespace stackchan
