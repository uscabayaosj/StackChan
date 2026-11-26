#include "xiaomi_sensor.h"

#include <chrono>
#include <condition_variable>
#include <mutex>

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <host/ble_hs.h>
#include <sdkconfig.h>

#include "utils/bleprph/bleprph.h"

namespace xiaomi_sensor {
namespace {

constexpr auto Tag = "XiaomiSensor";
constexpr auto ReadTimeout = std::chrono::milliseconds(6500);
constexpr auto ConnectTimeoutMs = 3800;
const ble_uuid128_t SensorService =
    BLE_UUID128_INIT(0xa6, 0xa3, 0x7d, 0x99, 0xf2, 0x6f, 0x1a, 0x8a, 0x0c, 0x4b, 0x0a, 0x7a, 0xb0, 0xcc, 0xe0, 0xeb);
const ble_uuid128_t Measurement =
    BLE_UUID128_INIT(0xa6, 0xa3, 0x7d, 0x99, 0xf2, 0x6f, 0x1a, 0x8a, 0x0c, 0x4b, 0x0a, 0x7a, 0xc1, 0xcc, 0xe0, 0xeb);

constexpr int hexDigit(char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

constexpr bool sensorAddress(ble_addr_t& address)
{
    constexpr char text[] = CONFIG_STACKCHAN_XIAOMI_SENSOR_ADDRESS;
    if (sizeof(text) != 18) return false;
    address.type = BLE_ADDR_PUBLIC;
    for (int index = 0; index < 6; ++index) {
        const int high = hexDigit(text[index * 3]);
        const int low = hexDigit(text[index * 3 + 1]);
        if (high < 0 || low < 0 || (index < 5 && text[index * 3 + 2] != ':')) return false;
        address.val[5 - index] = static_cast<uint8_t>((high << 4) | low);
    }
    return true;
}

constexpr ble_addr_t configuredAddress()
{
    ble_addr_t address{};
    sensorAddress(address);
    return address;
}

constexpr bool addressConfigured()
{
    ble_addr_t address{};
    return sensorAddress(address);
}

static_assert(sizeof(CONFIG_STACKCHAN_XIAOMI_SENSOR_ADDRESS) == 1 || addressConfigured(),
              "Expected a Xiaomi Bluetooth address in AA:BB:CC:DD:EE:FF format");

// NimBLE callbacks write to one request at a time. The callback token makes a
// late connection, notification, or disconnect distinguishable from a retry.
struct Request {
    std::mutex mutex;
    std::condition_variable changed;
    uintptr_t token = 0;
    uint16_t connection = BLE_HS_CONN_HANDLE_NONE;
    uint16_t serviceStart = 0;
    uint16_t serviceEnd = 0;
    uint16_t measurement = 0;
    uint16_t descriptorEnd = 0;
    uint16_t cccd = 0;
    bool complete = false;
    bool success = false;
    Reading reading{};
};

Request request;
constexpr ble_uuid16_t CccdUuid = BLE_UUID16_INIT(0x2902);

bool active(const void* token)
{
    return request.token == reinterpret_cast<uintptr_t>(token) && !request.complete;
}

void finish(bool success = false)
{
    request.success = success;
    request.complete = true;
    request.changed.notify_one();
}

int subscribed(uint16_t, const ble_gatt_error* error, ble_gatt_attr*, void* token)
{
    std::lock_guard lock(request.mutex);
    if (active(token) && error->status != 0) finish();
    return 0;
}

int descriptorFound(uint16_t connection, const ble_gatt_error* error, uint16_t,
                    const ble_gatt_dsc* descriptor, void* token)
{
    std::lock_guard lock(request.mutex);
    if (!active(token)) return 0;
    if (error->status == 0) {
        if (ble_uuid_cmp(&descriptor->uuid.u, &CccdUuid.u) == 0) request.cccd = descriptor->handle;
    } else if (error->status == BLE_HS_EDONE && request.cccd != 0) {
        constexpr uint8_t enableNotify[] = {0x01, 0x00};
        if (ble_gattc_write_flat(connection, request.cccd, enableNotify, sizeof(enableNotify), subscribed, token)) finish();
    } else {
        finish();
    }
    return 0;
}

int characteristicFound(uint16_t connection, const ble_gatt_error* error, const ble_gatt_chr* characteristic, void* token)
{
    std::lock_guard lock(request.mutex);
    if (!active(token)) return 0;
    if (error->status == 0) {
        if (ble_uuid_cmp(&characteristic->uuid.u, &Measurement.u) == 0 && (characteristic->properties & BLE_GATT_CHR_PROP_NOTIFY)) {
            request.measurement = characteristic->val_handle;
        } else if (request.measurement && request.descriptorEnd == request.serviceEnd) {
            request.descriptorEnd = characteristic->def_handle - 1;
        }
    } else if (error->status == BLE_HS_EDONE && request.measurement && request.descriptorEnd > request.measurement) {
        if (ble_gattc_disc_all_dscs(connection, request.measurement, request.descriptorEnd, descriptorFound, token)) finish();
    } else {
        finish();
    }
    return 0;
}

int serviceFound(uint16_t connection, const ble_gatt_error* error, const ble_gatt_svc* service, void* token)
{
    std::lock_guard lock(request.mutex);
    if (!active(token)) return 0;
    if (error->status == 0) {
        request.serviceStart = service->start_handle;
        request.serviceEnd = request.descriptorEnd = service->end_handle;
    } else if (error->status == BLE_HS_EDONE && request.serviceStart != 0) {
        if (ble_gattc_disc_all_chrs(connection, request.serviceStart, request.serviceEnd, characteristicFound, token)) finish();
    } else {
        finish();
    }
    return 0;
}

int onGap(ble_gap_event* event, void* token)
{
    std::unique_lock lock(request.mutex);
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (!active(token)) {
                lock.unlock();
                if (event->connect.status == 0) ble_gap_terminate(event->connect.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            } else if (event->connect.status != 0) {
                finish();
            } else {
                request.connection = event->connect.conn_handle;
                if (ble_gattc_disc_svc_by_uuid(request.connection, &SensorService.u, serviceFound, token)) finish();
            }
            break;
        case BLE_GAP_EVENT_DISCONNECT:
            if (request.token != reinterpret_cast<uintptr_t>(token)) break;
            request.connection = BLE_HS_CONN_HANDLE_NONE;
            if (active(token)) finish();
            break;
        case BLE_GAP_EVENT_NOTIFY_RX: {
            auto& notification = event->notify_rx;
            if (!active(token) || notification.conn_handle != request.connection ||
                notification.attr_handle != request.measurement) break;
            uint8_t data[5];
            if (OS_MBUF_PKTLEN(notification.om) != sizeof(data) ||
                os_mbuf_copydata(notification.om, 0, sizeof(data), data)) break;
            const auto temperature = static_cast<int16_t>(static_cast<uint16_t>(data[0] | (data[1] << 8)));
            if (temperature < -4000 || temperature > 8500 || data[2] > 100) break;
            request.reading = {temperature, data[2]};
            finish(true);
            break;
        }
        default:
            break;
    }
    return 0;
}

}  // namespace

bool configured()
{
    return addressConfigured();
}

void prepare()
{
    // Reserve controller memory before Wi-Fi and the audio front end start.
    // The host remains idle between reads.
    if (configured() && stackchan_ble_acquire_central() == 0) stackchan_ble_release_central();
}

bool read(Reading& reading)
{
    if (!addressConfigured()) return false;
    constexpr auto address = configuredAddress();

    if (stackchan_ble_acquire_central() != 0) return false;
    const auto deadline = std::chrono::steady_clock::now() + ReadTimeout;
    const auto syncDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1200);
    while (!ble_hs_synced() && std::chrono::steady_clock::now() < syncDeadline) vTaskDelay(1);

    uint8_t ownAddressType = 0;
    bool success = false;
    if (ble_hs_synced() && ble_hs_id_infer_auto(0, &ownAddressType) == 0) {
        static uintptr_t nextToken = 0;
        std::unique_lock lock(request.mutex);
        if (++nextToken == 0) ++nextToken;
        request.token = nextToken;
        request.connection = BLE_HS_CONN_HANDLE_NONE;
        request.serviceStart = request.serviceEnd = request.measurement = request.descriptorEnd = request.cccd = 0;
        request.complete = request.success = false;
        const auto token = reinterpret_cast<void*>(request.token);
        lock.unlock();

        const int rc = ble_gap_connect(ownAddressType, &address, ConnectTimeoutMs, nullptr, onGap, token);
        lock.lock();
        if (rc == 0) request.changed.wait_until(lock, deadline, [] { return request.complete; });
        success = request.complete && request.success;
        if (success) reading = request.reading;
        const auto connection = request.connection;
        request.token = 0;
        lock.unlock();
        if (connection != BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
        } else if (rc == 0) {
            ble_gap_conn_cancel();
        }
    }

    stackchan_ble_release_central();
    if (success) {
        ESP_LOGI(Tag, "Received a fresh indoor climate reading over Bluetooth");
    } else {
        ESP_LOGW(Tag, "No valid reading from the configured sensor");
    }
    return success;
}

}  // namespace xiaomi_sensor
