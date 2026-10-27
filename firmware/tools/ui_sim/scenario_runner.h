#pragma once

#include "avatar_scene.h"

#include <cstdint>
#include <string>
#include <vector>

struct ScenarioAssertion {
    std::string type;
    std::string target;
    int min_pixels = -1;
    int max_pixels = -1;
    int x_min = 0;
    int y_min = 0;
    int x_max = 319;
    int y_max = 239;
};

struct ScenarioEvent {
    std::uint32_t t = 0;
    std::string emotion;
    std::string status;
    std::string chat_role;
    std::string chat_text;
    std::string notification_text;
    std::string app_ready_state;
    std::uint32_t preview_duration_ms = 0;
    std::uint32_t notification_duration_ms = 0;
    bool clear_chat = false;
    bool has_chat = false;
    bool reset_scene = false;
    bool fake_launcher_screen = false;
    bool launch_hermes_app = false;
    bool preview_image = false;
    bool clear_preview = false;
    bool notification = false;
    bool clear_notification = false;
    int mouth_weight = -1;          // >= 0: hold the mouth at this weight (stops the speaking flap)
    bool disable_blink = false;     // remove the blink modifier so screenshots never catch a blink
    std::string screenshot;         // write a PPM of the next rendered frame to this path
    std::vector<ScenarioAssertion> assertions;
};

class ScenarioRunner {
public:
    bool load(const std::string& path, std::string& error);
    void update(std::uint32_t elapsed_ms, AvatarScene& scene);
    bool verifyDueAssertions(std::uint32_t elapsed_ms, const std::vector<std::uint8_t>& framebuffer, int width,
                             int height, std::string& error);
    std::uint32_t endTimeMs() const;
    bool empty() const;
    // Path of a screenshot requested by the events applied in the last update(), or empty.
    std::string takePendingScreenshot();

private:
    std::vector<ScenarioEvent> events_;
    std::size_t next_event_ = 0;
    std::size_t next_assertion_event_ = 0;
    std::string pending_screenshot_;
};
