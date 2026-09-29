// The few libbinder_ndk platform APIs a HAL service needs, which the NDK's headers leave out
// (AOSP: frameworks/native/libs/binder/ndk/include_platform). Declarations match Android 14; the
// implementations are in the device's libbinder_ndk.so, which scripts/build-gnss.sh links against.
#pragma once

#include <android/binder_ibinder.h>
#include <android/binder_status.h>
#include <stdint.h>

__BEGIN_DECLS

// binder_manager.h
binder_exception_t AServiceManager_addService(AIBinder* binder, const char* instance);

// binder_process.h
bool ABinderProcess_setThreadPoolMaxThreadCount(uint32_t numThreads);
void ABinderProcess_startThreadPool(void);
void ABinderProcess_joinThreadPool(void);

// binder_stability.h
void AIBinder_markVintfStability(AIBinder* binder);

__END_DECLS
