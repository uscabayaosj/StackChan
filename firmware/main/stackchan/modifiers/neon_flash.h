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

}  // namespace stackchan
