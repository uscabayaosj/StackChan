/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include "../modifiable.h"
#include <hal/hal.h>

namespace stackchan {

/**
 * @brief When the robot is knocked onto its side: freeze the head (no idle or requested moves),
 * look sad and say so. When set upright again: clear that and return the head home.
 */
class TipOverModifier : public Modifier {
public:
    TipOverModifier()
    {
        _signal_connection = GetHAL().onImuMotionEvent.connect([this](ImuMotionEvent e) {
            if (e == ImuMotionEvent::TipOver) _event_tip = true;
            if (e == ImuMotionEvent::Upright) _event_upright = true;
        });
    }

    ~TipOverModifier()
    {
        GetHAL().onImuMotionEvent.disconnect(_signal_connection);
    }

    void _update(Modifiable& stackchan) override
    {
        auto& avatar = stackchan.avatar();
        auto& motion = stackchan.motion();
        if (_event_tip) {
            _event_tip = false;
            _tipped    = true;
            avatar.setEmotion(avatar::Emotion::Sad);
            avatar.setSpeech("I've fallen over.");
        }
        if (_event_upright) {
            _event_upright = false;
            if (_tipped) {
                _tipped = false;
                avatar.setSpeech("");
                avatar.setEmotion(avatar::Emotion::Neutral);
                motion.setModifyLock(false);
                motion.goHome(300);
            }
        }
        // Keep the head still while lying down (other modifiers may release the lock).
        if (_tipped && !motion.isModifyLocked()) {
            motion.setModifyLock(true);
        }
    }

private:
    int _signal_connection;
    volatile bool _event_tip     = false;
    volatile bool _event_upright = false;
    bool _tipped                 = false;
};

}  // namespace stackchan
