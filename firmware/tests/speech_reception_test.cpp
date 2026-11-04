#include "hal/utils/audio/speech_reception.h"
#include <cassert>
int main() {
    SpeechReception stream;
    assert(!stream.AcceptsAudio());
    // Network START may be followed by binary frames before the UI task runs.
    stream.Start([&] { assert(!stream.AcceptsAudio()); });
    assert(stream.AcceptsAudio());
    stream.Stop();
    assert(!stream.AcceptsAudio());
    // A cancelled stream must not admit late packets; the next START recovers.
    stream.Start([&] { assert(!stream.AcceptsAudio()); });
    stream.Stop();
    assert(!stream.AcceptsAudio());
    stream.Start([&] { assert(!stream.AcceptsAudio()); });
    assert(stream.AcceptsAudio());
}
