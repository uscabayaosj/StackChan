#include "hal/speaker_bearing.h"

#include <cassert>
#include <cmath>
#include <iostream>
#include <random>

using speaker_tracking::EstimateBearing;
using speaker_tracking::MicWindow;
using speaker_tracking::kWindowSamples;

int main()
{
    std::mt19937 random(33);
    std::uniform_int_distribution<int> noise(-8000, 8000);
    MicWindow voice{}, background{}, delayed{};
    for (size_t i = 0; i < kWindowSamples; ++i) {
        voice[i] = noise(random);
        background[i] = noise(random);
    }

    for (const int offset : {-4, -2, 0, 2, 4}) {
        for (size_t i = 0; i < kWindowSamples; ++i) {
            const int index = static_cast<int>(i) - offset;
            delayed[i] = index >= 0 && index < static_cast<int>(kWindowSamples)
                ? static_cast<int16_t>(0.55 * voice[index] + noise(random) / 12)
                : 0;
        }
        const auto result = EstimateBearing(voice, delayed);
        assert(result.reliable);
        assert(std::abs(result.lag - offset) < 0.3f);
    }

    // A peak just beyond the physical range previously looked like a hard turn.
    for (int i = 7; i < static_cast<int>(kWindowSamples); ++i) delayed[i] = voice[i - 7];
    assert(!EstimateBearing(voice, delayed).reliable);

    speaker_tracking::LagVotes votes;
    for (float value : {1.25f, 1.3f, 1.35f, 4.8f, -1.0f}) votes.Add(value);
    assert(std::abs(votes.consensus(0.7f, 4).lag - 1.325f) < 0.01f);
    for (int i = 0; i < 5; ++i) votes.Add(0.f);
    assert(!votes.consensus(0.7f, 4).reliable);
    speaker_tracking::LagVotes frontal;
    for (float lag : {0.f, .9f, -.4f, 1.f}) frontal.Add(lag);
    const auto centered=frontal.consensus(speaker_tracking::kFrontalLag,3);
    assert(centered.reliable && centered.lag==0);

    // A wake is already looking off to the side. Neither the first VAD
    // view check nor a transcript with no direction should abort it.
    using speaker_tracking::Bearing;
    using speaker_tracking::replacesActiveLook;
    const Bearing wake{3.f,true};
    assert(!replacesActiveLook(wake,true,{},false));
    assert(!replacesActiveLook(wake,true,centered,false));
    assert(!replacesActiveLook(wake,true,{},true));
    assert(!replacesActiveLook(wake,true,{2.8f,true},true));
    assert(replacesActiveLook(wake,true,centered,true));
    assert(replacesActiveLook(wake,true,{-3.f,true},true));
    assert(!replacesActiveLook({},true,{},true));
    assert(replacesActiveLook({},true,wake,true));
    assert(replacesActiveLook({},false,{},true));

    using speaker_tracking::LookAction;
    speaker_tracking::FollowupVoice shortQuestion;
    speaker_tracking::SpeechLook followup;
    assert(followup.observe(1000,145,centered)==LookAction::CheckView);
    assert(!shortQuestion.feed(24*150));
    assert(!shortQuestion.enough(centered)); // A brief VAD blip can check only the current view.
    shortQuestion={};
    assert(shortQuestion.feed(24*260) && shortQuestion.enough(centered));
    assert(!shortQuestion.enough({})); // No reliable direction requires more voiced input.
    assert(shortQuestion.feed(24*120) && shortQuestion.enough({}));
    auto rejected=followup;
    assert(rejected.observe(1270,410,{},false,true)==LookAction::Search);
    // A rejected camera request leaves the live state eligible on the next callback.
    assert(!followup.searched);
    assert(followup.observe(1410,550,{},false,true)==LookAction::Search);
    assert(followup.observe(1550,690,{},false,true)==LookAction::None);
    speaker_tracking::UtteranceRetry retry;
    auto listen=[&](bool speaking, unsigned milliseconds) {
        for (unsigned t=0;t<milliseconds;t+=10) retry.feed(speaking,240);
    };
    listen(false,1200); listen(true,900);
    assert(!retry.take(centered)); // A pause within the same utterance.
    listen(false,900); retry.interrupt(); listen(false,700); listen(true,800);
    assert(!retry.take(centered)); // Motor/playback gaps cannot combine two silences.
    listen(false,1510); listen(true,170);
    assert(!retry.take(centered)); // A VAD blip consumes no retry.
    listen(false,100); listen(true,320);
    assert(!retry.take({}) && retry.take(centered));
    listen(false,2000); listen(true,900);
    assert(!retry.take(centered)); // At most one additional acquisition per turn.
    retry={}; listen(false,1600); listen(true,600);
    assert(!retry.take({})); listen(true,60);
    assert(retry.take({})); // A real utterance need not yield a left/right estimate.
    speaker_tracking::SpeechLook look;
    // Replay the follow-up in which the present view was empty and the first
    // microphone estimate was unresolved. One scan should own the whole turn.
    assert(look.observe(900,90,{},true)==LookAction::None);
    assert(look.observe(1000,150,{},true)==LookAction::Search);
    for (uint32_t t=1140;t<=1980;t+=140) assert(look.observe(t,t-850,centered,true)==LookAction::None);
    look={};
    assert(look.observe(1000,150,centered,true)==LookAction::Search);
    assert(look.observe(1140,290,centered,true)==LookAction::None);
    look={};
    assert(look.observe(1000,150,{},true)==LookAction::Search);
    assert(look.observe(1140,290,{2.5f,true})==LookAction::None);
    assert(look.observe(1280,430,{2.5f,true})==LookAction::None);
    assert(look.observe(1420,570,{2.5f,true})==LookAction::Search);
    assert(look.observe(1560,710,{2.5f,true})==LookAction::None);
    look={};
    assert(look.observe(1000,150,{},true)==LookAction::Search);
    look.moved();
    for (uint32_t t=1800;t<=2500;t+=140) assert(look.observe(t,t-850,{2.5f,true})==LookAction::None);
    look={};
    assert(look.observe(1000,145,{})==LookAction::CheckView);
    for (uint32_t t=1140;t<2000;t+=140) assert(look.observe(t,t-800,{})==LookAction::None);
    assert(look.observe(2140,1200,{1.7f,true})==LookAction::None);
    assert(look.observe(2280,1340,{1.7f,true})==LookAction::None);
    assert(look.observe(2420,1480,{1.7f,true})==LookAction::Search);
    // An isolated outlier must not switch the speaker. A sustained bearing
    // change can represent a second person on the same side of the head.
    assert(look.observe(3600,2400,{3.4f,true})==LookAction::None);
    assert(look.observe(3740,2540,{1.8f,true})==LookAction::None);
    assert(look.observe(3880,2680,{3.4f,true})==LookAction::None);
    assert(look.observe(4020,2820,{3.4f,true})==LookAction::None);
    assert(look.observe(4160,2960,{3.4f,true})==LookAction::Search);
    look.moved();
    for (uint32_t t=5500;t<=6060;t+=140) assert(look.observe(t,t-4500,{-2.3f,true})==LookAction::None);
    assert(look.observe(6300,2000,{2.4f,true})==LookAction::None);
    assert(look.observe(6440,2140,{2.4f,true})==LookAction::None);
    assert(look.observe(6580,2280,{2.4f,true})==LookAction::Search);
    look={};
    assert(look.observe(1000,150,centered)==LookAction::CheckView);
    for (uint32_t t=1140;t<=1420;t+=140) assert(look.observe(t,t-850,centered)==LookAction::None);
    assert(look.observe(1560,710,centered)==LookAction::Search);
    assert(look.observe(1900,1050,centered)==LookAction::None);
    // Physical slot 1 carries the echo reference. A left/right delay of either
    // sign must align microphone slots 0 and 2 without mixing in that reference.
    for (int delay : {-3, 0, 3}) {
        std::array<int16_t,kWindowSamples*4> slots{};
        for (size_t i=0;i<kWindowSamples;++i) {
            slots[i*4]=voice[i];
            slots[i*4+1]=30000;
            int source=static_cast<int>(i)-delay;
            if (source>=0 && source<static_cast<int>(kWindowSamples)) slots[i*4+2]=voice[source];
        }
        for (size_t i=0;i<kWindowSamples;++i) {
            assert(speaker_tracking::conversationSample(slots.data(),kWindowSamples,i,delay)==voice[i]);
            assert(speaker_tracking::conversationSample(slots.data(),kWindowSamples,i,speaker_tracking::kUnknownAlignment)==voice[i]);
        }
    }
    MicWindow silent{};
    assert(!EstimateBearing(silent, silent).reliable);
    assert(!EstimateBearing(voice, silent).reliable);
    assert(!EstimateBearing(voice, background).reliable);

    MicWindow repeating{};
    for (size_t i = 0; i < kWindowSamples; ++i) {
        repeating[i] = i % 3 == 0 ? 12000 : -6000;
    }
    assert(!EstimateBearing(repeating, repeating).reliable);
    std::cout << "Speaker bearing passes left, right, centered, silence, noise, ambiguous signals, out-of-range echoes and stereo speech alignment.\n";
}
