/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "reminder.h"
#include <smooth_ui_toolkit.hpp>
#include <uitk/short_namespace.hpp>
#include <mooncake_log.h>
#include <string_view>
#include <mutex>
#include <hal/hal.h>

using namespace uitk;

class ReminderManager {
public:
    struct Reminder {
        int id;
        uint32_t triggerAt;
        uint32_t duration;
        std::string message;
        bool repeat;
    };

    Signal<int, std::string_view> onReminderTriggered;

    ReminderManager() = default;

    void init()
    {
        _reminders.reserve(5);
        _next_id = 1;
    }

    int createReminder(uint32_t durationMs, std::string_view message, bool repeat)
    {
        int id       = _next_id++;
        uint32_t now = GetHAL().millis();

        _reminders.push_back({id, now + durationMs, durationMs, std::string(message), repeat});

        return id;
    }

    bool stopReminder(int id)
    {
        auto it = std::find_if(_reminders.begin(), _reminders.end(), [id](const Reminder& r) { return r.id == id; });

        if (it != _reminders.end()) {
            _reminders.erase(it);
            return true;
        }
        return false;
    }

    void update()
    {
        if (_reminders.empty()) return;

        uint32_t now = GetHAL().millis();

        for (auto it = _reminders.begin(); it != _reminders.end();) {
            if (static_cast<int32_t>(now - it->triggerAt) >= 0) {
                onReminderTriggered.emit(it->id, it->message);
                if (it->repeat) {
                    it->triggerAt = now + it->duration;
                    ++it;
                } else {
                    it = _reminders.erase(it);
                }
            } else {
                ++it;
            }
        }
    }

    std::vector<tools::ReminderInfo_t> getActiveReminders() const
    {
        std::vector<tools::ReminderInfo_t> result;
        result.reserve(_reminders.size());
        const uint32_t now = GetHAL().millis();
        for (const auto& r : _reminders) {
            const auto remaining = static_cast<int32_t>(r.triggerAt - now);
            result.push_back({r.id, r.duration, r.message, r.repeat, remaining > 0 ? static_cast<uint32_t>(remaining) : 0U});
        }
        return result;
    }

private:
    std::vector<Reminder> _reminders;
    int _next_id = 1;
};

namespace tools {

static std::mutex reminder_mutex;
static std::unique_ptr<ReminderManager> _reminder_manager;

static ReminderManager& get_reminder_manager()
{
    if (!_reminder_manager) {
        _reminder_manager = std::make_unique<ReminderManager>();
        _reminder_manager->init();
    }
    return *_reminder_manager;
}

uitk::Signal<int, std::string_view>& on_reminder_triggered()
{
    return get_reminder_manager().onReminderTriggered;
}

int create_reminder(uint32_t durationMs, std::string_view message, bool repeat)
{
    std::lock_guard lock(reminder_mutex);
    return get_reminder_manager().createReminder(durationMs, message, repeat);
}

bool stop_reminder(int id)
{
    std::lock_guard lock(reminder_mutex);
    return _reminder_manager && _reminder_manager->stopReminder(id);
}

void update_reminders()
{
    std::lock_guard lock(reminder_mutex);
    if (_reminder_manager) {
        _reminder_manager->update();
    }
}

std::vector<ReminderInfo_t> get_active_reminders()
{
    std::lock_guard lock(reminder_mutex);
    return get_reminder_manager().getActiveReminders();
}

}  // namespace tools
