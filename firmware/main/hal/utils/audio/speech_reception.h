#pragma once
#include <atomic>

// Protocol START/STOP and binary audio share a receive task. The visual state
// changes later on the application task, so it cannot be the admission gate.
class SpeechReception {
public:
    template<class Prepare> void Start(Prepare prepare) {
        active_.store(false);
        prepare();
        active_.store(true);
    }
    void Stop() { active_.store(false); }
    bool AcceptsAudio() const { return active_.load(); }
private:
    std::atomic<bool> active_{false};
};
