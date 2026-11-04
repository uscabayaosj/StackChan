#include "network_credentials.h"
#include "network_policy.h"
#include <esp_eap_client.h>
#include <nvs.h>
#include <sys/time.h>
#include <ctime>

extern const unsigned char ucl_ca_start[] asm("_binary_ucl_eduroam_pem_start");
extern const unsigned char ucl_ca_end[] asm("_binary_ucl_eduroam_pem_end");

namespace stackchan::wifi {
esp_err_t ConfigureSecurity(const std::string& ssid, const std::string& password, const EnterpriseCredentials& enterprise) {
    // This call also clears credentials left by a previous enterprise network.
    auto error = esp_wifi_sta_enterprise_disable();
    if (error != ESP_OK) return error;
    if (enterprise.security.empty()) return ssid == "eduroam" ? ESP_ERR_INVALID_ARG : ESP_OK;
    if (enterprise.security != "ucl-eduroam" || ssid != "eduroam" ||
        !ValidUclIdentity(enterprise.username) || password.empty() || password.size() > 64) return ESP_ERR_INVALID_ARG;
    // The phone supplies current time at provisioning. Keep the last known time
    // for cold boots before a network is available; never disable certificate dates.
    int64_t known_time = enterprise.unix_time;
    nvs_handle_t nvs;
    if (nvs_open("wifi_profiles", NVS_READONLY, &nvs) == ESP_OK) {
        int64_t saved_time = 0;
        nvs_get_i64(nvs, "ucl_time", &saved_time);
        known_time = std::max(known_time, saved_time);
        nvs_close(nvs);
    }
    if (known_time >= 1793491200 && known_time < 4102444800LL && time(nullptr) < known_time) {
        timeval tv{static_cast<time_t>(known_time), 0};
        settimeofday(&tv, nullptr);
    }
    if (time(nullptr) < 1793491200) return ESP_ERR_INVALID_STATE;
    const auto* username = reinterpret_cast<const unsigned char*>(enterprise.username.data());
    const auto* secret = reinterpret_cast<const unsigned char*>(password.data());
    if ((error = esp_eap_client_set_eap_methods(ESP_EAP_TYPE_PEAP)) != ESP_OK ||
        (error = esp_eap_client_set_identity(username, enterprise.username.size())) != ESP_OK ||
        (error = esp_eap_client_set_username(username, enterprise.username.size())) != ESP_OK ||
        (error = esp_eap_client_set_password(secret, password.size())) != ESP_OK ||
        (error = esp_eap_client_use_default_cert_bundle(false)) != ESP_OK ||
        (error = esp_eap_client_set_ca_cert(ucl_ca_start, ucl_ca_end - ucl_ca_start)) != ESP_OK ||
        (error = esp_eap_client_set_domain_name("eduroam.ucl.ac.uk")) != ESP_OK ||
        (error = esp_eap_client_set_disable_time_check(false)) != ESP_OK) return error;
    return esp_wifi_sta_enterprise_enable();
}

esp_err_t SaveNetworkChoice(const std::string& ssid, const EnterpriseCredentials& enterprise) {
    nvs_handle_t nvs;
    auto error = nvs_open("wifi_profiles", NVS_READWRITE, &nvs);
    if (error != ESP_OK) return error;
    error = nvs_set_str(nvs, "preferred", ssid.c_str());
    if (error == ESP_OK && ssid == "eduroam") {
        if (enterprise.security == "ucl-eduroam") {
            error = nvs_set_str(nvs, "ucl_username", enterprise.username.c_str());
            if (error == ESP_OK) error = nvs_set_i64(nvs, "ucl_time", time(nullptr));
        } else {
            const auto erased = nvs_erase_key(nvs, "ucl_username");
            if (erased != ESP_OK && erased != ESP_ERR_NVS_NOT_FOUND) error = erased;
        }
    }
    if (error == ESP_OK) error = nvs_commit(nvs);
    nvs_close(nvs);
    return error;
}
}

// Hooks used by the unmodified managed component's generated source overlay.
std::string stackchan_wifi_preferred() {
    nvs_handle_t nvs;
    if (nvs_open("wifi_profiles", NVS_READONLY, &nvs) != ESP_OK) return {};
    char ssid[33]{}; size_t length = sizeof(ssid);
    if (nvs_get_str(nvs, "preferred", ssid, &length) != ESP_OK) ssid[0] = 0;
    nvs_close(nvs);
    return ssid;
}
esp_err_t stackchan_wifi_prepare(const std::string& ssid, const std::string& password) {
    stackchan::wifi::EnterpriseCredentials enterprise;
    if (ssid == "eduroam") {
        nvs_handle_t nvs;
        if (nvs_open("wifi_profiles", NVS_READONLY, &nvs) == ESP_OK) {
            char username[129]{}; size_t length = sizeof(username);
            if (nvs_get_str(nvs, "ucl_username", username, &length) == ESP_OK) {
                enterprise.security = "ucl-eduroam";
                enterprise.username = username;
            }
            nvs_close(nvs);
        }
        // Never attempt eduroam using a shared password or unvalidated server.
        if (enterprise.security.empty()) return ESP_ERR_INVALID_STATE;
    }
    return stackchan::wifi::ConfigureSecurity(ssid, password, enterprise);
}
