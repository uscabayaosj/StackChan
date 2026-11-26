#pragma once

#include <cstdint>

namespace xiaomi_sensor {

struct Reading {
    std::int16_t temperature_centi_celsius;
    std::uint8_t humidity_percent;
};

bool configured();
void prepare();
bool read(Reading& reading);

}  // namespace xiaomi_sensor
