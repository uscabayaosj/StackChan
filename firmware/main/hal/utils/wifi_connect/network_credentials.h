#pragma once
#include <string>
#include <esp_err.h>
namespace stackchan::wifi {
struct EnterpriseCredentials {
    std::string security;
    std::string username;
    int64_t unix_time = 0;
};
esp_err_t ConfigureSecurity(const std::string& ssid, const std::string& password, const EnterpriseCredentials& enterprise);
esp_err_t SaveNetworkChoice(const std::string& ssid, const EnterpriseCredentials& enterprise);
}
