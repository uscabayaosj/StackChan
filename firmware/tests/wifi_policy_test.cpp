#include "hal/utils/wifi_connect/network_policy.h"
#include <cassert>
int main() {
    using namespace stackchan::wifi;
    std::vector<Candidate> aps{{"Saoirse", -30, 0}, {"ClaphamSJ", -82, 1}, {"ClaphamSJ", -58, 2}};
    auto ordered = OrderCandidates(aps, "ClaphamSJ");
    assert(ordered[0].index == 2 && ordered[1].index == 1 && ordered[2].index == 0);
    ordered = OrderCandidates(aps, "absent");
    assert(ordered[0].index == 0 && ordered[1].index == 2);
    assert(ValidUclIdentity("abc123@ucl.ac.uk"));
    assert(!ValidUclIdentity("abc123@example.org"));
    assert(!ValidUclIdentity("@ucl.ac.uk"));
    assert(!ValidUclIdentity("abc@other@ucl.ac.uk"));
    assert(!ValidUclIdentity(std::string("abc\0@ucl.ac.uk", 14)));
}
