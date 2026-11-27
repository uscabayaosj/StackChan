#include "hal/face_aim.h"
#include <cassert>
#include <cstdio>

int main()
{
    using namespace face_aim;
    ReplyGate gate;
    auto wakeTurn=gate.turn();
    assert(gate.accepts(wakeTurn));
    gate.pause();  // A protocol START may arrive between exposure and inference.
    assert(!gate.accepts(wakeTurn) && !gate.accepts(gate.turn()));
    gate.pause();
    gate.resume();
    auto followupTurn=gate.turn();
    assert(gate.accepts(followupTurn) && !gate.accepts(wakeTurn));
    gate.resume();  // An ordinary state notification preserves a current listening job.
    assert(gate.accepts(followupTurn));
    gate.pause();
    gate.resume();
    assert(!gate.accepts(followupTurn) && gate.accepts(gate.turn()));

    static_assert(detectorInputSize(false,false).width==160 && detectorInputSize(false,false).height==120);
    static_assert(detectorInputSize(true,false).width==320 && detectorInputSize(true,false).height==240);
    static_assert(detectorInputSize(true,true).width==160 && detectorInputSize(true,true).height==120);
    auto explicitSearch=planSearch(0,150,150,0,false,true);
    assert(explicitSearch.count==3 && explicitSearch.views[2].pitch>150);
    for (int yaw : {-680,-220,0,220,680}) {
        for (float bearing : {-60.f,-20.f,0.f,20.f,60.f}) {
            auto automatic=planSearch(yaw,150,150,bearing,bearing!=0,false);
            assert(automatic.count>=1 && automatic.count<=2);
            for (int i=0;i<automatic.count;++i) assert(automatic.views[i].pitch==150);
        }
    }
    for (int side : {-1,1}) {
        auto moved=planSearch(side*220,150,150,0,false,false);
        assert(moved.views[0].yaw==-side*220);
    }
    assert(correction(0,width,62,16)==0);
    assert(correction(8,width,62,16)==0);
    assert(correction(70,width,62,16)==16);
    assert(correction(-70,width,62,16)==-16);
    assert(consistent({80,59,33},{83,61,32}));
    assert(!consistent({40,59,33},{125,61,32}));
    // From the recorded wake pose the old controller sampled -90, -1 and -6
    // degrees and missed the opposite side. The unreachable bearing must not
    // consume a probe or collapse the second tilt into the first two.
    auto wake=planSearch(-560,320,150,-51.f,true);
    assert(wake.count==3);
    assert(wake.views[0].yaw==-220 && wake.views[1].yaw==220);
    assert(wake.views[2].yaw==0 && wake.views[2].pitch!=wake.views[0].pitch);
    for (int sign : {-1,1}) {
        auto follow=planSearch(sign*240,150,150,0,false);
        assert(follow.views[0].yaw==-sign*220);
        auto edge=planSearch(sign*900,870,150,sign*55.f,true);
        assert(edge.views[0].yaw==sign*220 && edge.views[1].yaw==-sign*220);
        assert(edge.views[2].pitch<edge.views[0].pitch);
        auto hint=planSearch(0,150,150,sign*38.f,true);
        assert(hint.views[0].yaw==sign*380);
    }
    for (int yaw=-900;yaw<=900;yaw+=30) for (int pitch : {30,150,320,700,870}) {
        for (float lag : {-65.f,-25.f,0.f,25.f,65.f}) {
            auto probes=planSearch(yaw,pitch,150,lag,lag!=0.f);
            assert(probes.count>0 && probes.count<=3);
            bool crossed=false;
            for (int i=0;i<probes.count;++i) {
                auto v=probes.views[i];
                assert(std::abs(v.yaw)<=900 && v.pitch>=30 && v.pitch<=700);
                assert(std::abs(v.yaw-yaw)>=160 || std::abs(v.pitch-pitch)>=120);
                for (int j=0;j<i;++j) assert(std::abs(v.yaw-probes.views[j].yaw)>=160 ||
                                               std::abs(v.pitch-probes.views[j].pitch)>=120);
                if ((yaw<0 && v.yaw>=150) || (yaw>0 && v.yaw<=-150)) crossed=true;
            }
            if (std::abs(yaw)>=150) assert(crossed);
        }
    }
    Candidates none;
    assert(!none.choose(false).size);
    for (float lag : {-1.7f,1.7f,0.f}) {
        Candidates two;
        two.add({39,60,32},bearingDegrees(lag));
        two.add({121,60,30},bearingDegrees(lag));
        assert(!two.choose(false).size);
        auto selected=two.choose(true);
        if (!lag) assert(!selected.size);
        else assert(lag<0 ? selected.x==121 : selected.x==39);
    }
    Candidates single;
    single.add({112,60,42},-25);
    assert(single.choose(false).x==112);
    std::puts("Face selection, speaker switches, angular correction and centered hold passed.");
}
