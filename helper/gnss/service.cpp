// A GNSS HAL (android.hardware.gnss AIDL v3) for redroid, which has no GPS. While Android has GPS
// started, it reports the location in the vendor.gnss.location property ("lat,lng,accuracy",
// set by the server) as a GPS fix once a second.
//
// Why not test providers (cmd location providers set-test-provider-location)? Android marks those
// locations as mock, and some apps (McDonald's) ignore mock locations. Fixes from a GNSS HAL come
// through the real "gps" provider and aren't marked.
//
// Built with the NDK by scripts/build-gnss.sh; installed as
// /vendor/bin/hw/android.hardware.gnss-service.kaios (see docker/overlay).
#include <aidl/android/hardware/gnss/BnGnss.h>
#include <android/binder_manager.h>
#include <android/binder_process.h>
#include <android/log.h>
#include <sys/system_properties.h>
#include <time.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <thread>

using aidl::android::hardware::gnss::BnGnss;
using aidl::android::hardware::gnss::ElapsedRealtime;
using aidl::android::hardware::gnss::GnssLocation;
using aidl::android::hardware::gnss::IAGnss;
using aidl::android::hardware::gnss::IAGnssRil;
using aidl::android::hardware::gnss::IGnss;
using aidl::android::hardware::gnss::IGnssAntennaInfo;
using aidl::android::hardware::gnss::IGnssBatching;
using aidl::android::hardware::gnss::IGnssCallback;
using aidl::android::hardware::gnss::IGnssConfiguration;
using aidl::android::hardware::gnss::IGnssDebug;
using aidl::android::hardware::gnss::IGnssGeofence;
using aidl::android::hardware::gnss::IGnssMeasurementInterface;
using aidl::android::hardware::gnss::IGnssNavigationMessageInterface;
using aidl::android::hardware::gnss::IGnssPowerIndication;
using aidl::android::hardware::gnss::IGnssPsds;
using aidl::android::hardware::gnss::measurement_corrections::IMeasurementCorrectionsInterface;
using aidl::android::hardware::gnss::visibility_control::IGnssVisibilityControl;
using ndk::ScopedAStatus;

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "gnss-kaios", __VA_ARGS__)

static const char* kLocationProperty = "vendor.gnss.location";

static int64_t nowNs(clockid_t clock) {
    timespec ts;
    clock_gettime(clock, &ts);
    return int64_t(ts.tv_sec) * 1000000000 + ts.tv_nsec;
}

// Optional extensions: Android handles "unsupported" for each of them.
#define UNSUPPORTED(Type, method)                                              \
    ScopedAStatus method(std::shared_ptr<Type>* out) override {                \
        *out = nullptr;                                                        \
        return ScopedAStatus::fromExceptionCode(EX_UNSUPPORTED_OPERATION);     \
    }

class Gnss : public BnGnss {
  public:
    ScopedAStatus setCallback(const std::shared_ptr<IGnssCallback>& callback) override {
        std::lock_guard<std::mutex> lock(mMutex);
        mCallback = callback;
        if (!callback) return ScopedAStatus::ok();
        callback->gnssSetCapabilitiesCb(IGnssCallback::CAPABILITY_SCHEDULING);
        IGnssCallback::GnssSystemInfo info;
        info.yearOfHw = 2023;
        info.name = "android-on-kaios GNSS";
        callback->gnssSetSystemInfoCb(info);
        return ScopedAStatus::ok();
    }

    ScopedAStatus close() override {
        stop();
        std::lock_guard<std::mutex> lock(mMutex);
        mCallback = nullptr;
        return ScopedAStatus::ok();
    }

    ScopedAStatus start() override {
        std::unique_lock<std::mutex> lock(mMutex);
        if (mActive) return ScopedAStatus::ok();
        mActive = true;
        if (mCallback) mCallback->gnssStatusCb(IGnssCallback::GnssStatusValue::SESSION_BEGIN);
        if (mThread.joinable()) mThread.join();
        mThread = std::thread([this] { run(); });
        return ScopedAStatus::ok();
    }

    ScopedAStatus stop() override {
        std::thread thread;
        {
            std::lock_guard<std::mutex> lock(mMutex);
            if (!mActive) return ScopedAStatus::ok();
            mActive = false;
            thread = std::move(mThread);
            if (mCallback) mCallback->gnssStatusCb(IGnssCallback::GnssStatusValue::SESSION_END);
        }
        mWake.notify_all();
        if (thread.joinable()) thread.join();
        return ScopedAStatus::ok();
    }

    ScopedAStatus setPositionMode(const IGnss::PositionModeOptions& options) override {
        std::lock_guard<std::mutex> lock(mMutex);
        mIntervalMs = std::max(1000, options.minIntervalMs);
        return ScopedAStatus::ok();
    }

    ScopedAStatus injectTime(int64_t, int64_t, int32_t) override { return ScopedAStatus::ok(); }
    ScopedAStatus injectLocation(const GnssLocation&) override { return ScopedAStatus::ok(); }
    ScopedAStatus injectBestLocation(const GnssLocation&) override { return ScopedAStatus::ok(); }
    ScopedAStatus deleteAidingData(IGnss::GnssAidingData) override { return ScopedAStatus::ok(); }
    ScopedAStatus startSvStatus() override { return ScopedAStatus::ok(); }
    ScopedAStatus stopSvStatus() override { return ScopedAStatus::ok(); }
    ScopedAStatus startNmea() override { return ScopedAStatus::ok(); }
    ScopedAStatus stopNmea() override { return ScopedAStatus::ok(); }

    UNSUPPORTED(IGnssPsds, getExtensionPsds)
    UNSUPPORTED(IGnssConfiguration, getExtensionGnssConfiguration)
    UNSUPPORTED(IGnssMeasurementInterface, getExtensionGnssMeasurement)
    UNSUPPORTED(IGnssPowerIndication, getExtensionGnssPowerIndication)
    UNSUPPORTED(IGnssBatching, getExtensionGnssBatching)
    UNSUPPORTED(IGnssGeofence, getExtensionGnssGeofence)
    UNSUPPORTED(IGnssNavigationMessageInterface, getExtensionGnssNavigationMessage)
    UNSUPPORTED(IAGnss, getExtensionAGnss)
    UNSUPPORTED(IAGnssRil, getExtensionAGnssRil)
    UNSUPPORTED(IGnssDebug, getExtensionGnssDebug)
    UNSUPPORTED(IGnssVisibilityControl, getExtensionGnssVisibilityControl)
    UNSUPPORTED(IGnssAntennaInfo, getExtensionGnssAntennaInfo)
    UNSUPPORTED(IMeasurementCorrectionsInterface, getExtensionMeasurementCorrections)

  private:
    // Reports a fix every interval while started (none while the property is unset or invalid).
    void run() {
        std::unique_lock<std::mutex> lock(mMutex);
        while (mActive) {
            GnssLocation location;
            if (readLocation(&location) && mCallback) mCallback->gnssLocationCb(location);
            mWake.wait_for(lock, std::chrono::milliseconds(mIntervalMs), [this] { return !mActive; });
        }
    }

    static bool readLocation(GnssLocation* location) {
        char value[PROP_VALUE_MAX] = "";
        double lat, lng, accuracy;
        if (__system_property_get(kLocationProperty, value) <= 0 ||
            sscanf(value, "%lf,%lf,%lf", &lat, &lng, &accuracy) != 3 || lat < -90 || lat > 90 ||
            lng < -180 || lng > 180 || accuracy <= 0) {
            return false;
        }
        location->gnssLocationFlags = GnssLocation::HAS_LAT_LONG | GnssLocation::HAS_ALTITUDE |
                                      GnssLocation::HAS_SPEED | GnssLocation::HAS_HORIZONTAL_ACCURACY |
                                      GnssLocation::HAS_VERTICAL_ACCURACY |
                                      GnssLocation::HAS_SPEED_ACCURACY;
        location->latitudeDegrees = lat;
        location->longitudeDegrees = lng;
        location->altitudeMeters = 20;
        location->speedMetersPerSec = 0;
        location->horizontalAccuracyMeters = accuracy;
        location->verticalAccuracyMeters = accuracy * 1.5;
        location->speedAccuracyMetersPerSecond = 0.5;
        location->timestampMillis = nowNs(CLOCK_REALTIME) / 1000000;
        location->elapsedRealtime.flags = ElapsedRealtime::HAS_TIMESTAMP_NS;
        location->elapsedRealtime.timestampNs = nowNs(CLOCK_BOOTTIME);
        return true;
    }

    std::mutex mMutex;
    std::condition_variable mWake;
    std::thread mThread;
    std::shared_ptr<IGnssCallback> mCallback;
    bool mActive = false;
    int mIntervalMs = 1000;
};

int main() {
    ABinderProcess_setThreadPoolMaxThreadCount(1);
    ABinderProcess_startThreadPool();
    auto gnss = ndk::SharedRefBase::make<Gnss>();
    const std::string instance = std::string(Gnss::descriptor) + "/default";
    if (AServiceManager_addService(gnss->asBinder().get(), instance.c_str()) != STATUS_OK) {
        LOG("failed to register %s", instance.c_str());
        return 1;
    }
    LOG("registered %s", instance.c_str());
    ABinderProcess_joinThreadPool();
    return 1;
}
