/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include <display/lvgl_display/lvgl_display.h>
#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_ops.h>
#include <memory>
#include "info_card_overlay.h"
#include <stackchan/avatar/avatar/avatar.h>

class StackChanAvatarDisplay : public LvglDisplay {
private:
    esp_lcd_panel_io_handle_t panel_io_ = nullptr;
    esp_lcd_panel_handle_t panel_       = nullptr;
    int speaking_modifier_id_           = -1;
    int idle_motion_modifier_id_        = -1;
    int idle_expression_modifier_id_    = -1;
    int blink_modifier_id_              = -1;
    bool is_sleeping_                   = false;
    int neon_flash_modifier_id_         = -1;
    /** Colour both neon light bars show for the current state (listening green, speaking blue, off). */
    uint8_t state_light_[3]             = {0, 0, 0};

    void SetStateLight(uint8_t r, uint8_t g, uint8_t b);
    void StartHappyFlash();
    void SetConversationFace(stackchan::avatar::ConversationActivity activity);
    void UpdateConversationFace();
    lv_timer_t* conversation_timer_ = nullptr;
    stackchan::avatar::ConversationActivity face_rest_activity_ = stackchan::avatar::ConversationActivity::Idle;
    uint32_t thinking_started_ms_ = 0;
    bool reply_audio_expected_ = false;

public:
    /** Shows the user's requested light colour if set (robot.set_led_color), else the state colour. */
    void ApplyStateLight();

private:
    uint8_t idle_motion_level_          = 2;

    lv_obj_t* preview_image_                         = nullptr;
    lv_timer_t* preview_timer_                      = nullptr;
    uint32_t shutter_started_ms_                    = 0;
    uint32_t shutter_duration_ms_                   = 0;
    bool preview_waiting_                           = false;
    std::unique_ptr<LvglImage> preview_image_cached_ = nullptr;
    InfoCardOverlay info_cards_;

    void CreateIdleMotionModifier();
    void HidePhotoPreview();
    void ShowPhotoPreview();
    void SchedulePreviewTimer(uint32_t delayMs);

protected:
    virtual bool Lock(int timeout_ms = 0) override;
    virtual void Unlock() override;

public:
    StackChanAvatarDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel, int width, int height,
                           int offset_x, int offset_y, bool mirror_x, bool mirror_y, bool swap_xy);
    virtual ~StackChanAvatarDisplay();

    void InitializeLcdThemes();

    // Override Display methods to control Robot
    virtual void SetEmotion(const char* emotion) override;
    virtual void SetChatMessage(const char* role, const char* content) override;
    virtual void ClearChatMessages() override;
    virtual void SetPreviewImage(std::unique_ptr<LvglImage> image) override;
    virtual void UpdateStatusBar(bool update_all = false) override;
    virtual void SetupUI() override;
    virtual void SetTheme(Theme* theme) override;
    virtual void SetStatus(const char* status) override;
    virtual void ShowNotification(const char* notification, int duration_ms = 3000) override;
    void PlayPhotoShutter();
    void ShowInfoCard(const InfoCard& card) override;
    void StartTimerCard(int id, uint32_t duration_ms, const std::string& name);
    void StopTimerCard(int id);
    void ShowReminderDue(int id, const std::string& message, bool timer);

    void LvglLock();
    void LvglUnlock();
    lv_disp_t* GetLvglDisplay();
};
