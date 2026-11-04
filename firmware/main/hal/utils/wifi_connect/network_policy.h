#pragma once
#include <algorithm>
#include <string>
#include <vector>
#include <cctype>

namespace stackchan::wifi {
struct Candidate { std::string ssid; int rssi; size_t index; };
inline std::vector<Candidate> OrderCandidates(std::vector<Candidate> candidates, const std::string& preferred) {
    std::stable_sort(candidates.begin(), candidates.end(), [&](const auto& a, const auto& b) {
        const bool ap = !preferred.empty() && a.ssid == preferred;
        const bool bp = !preferred.empty() && b.ssid == preferred;
        return ap != bp ? ap : a.rssi > b.rssi;
    });
    return candidates;
}
inline bool ValidUclIdentity(const std::string& identity) {
    const std::string suffix = "@ucl.ac.uk";
    return identity.size() > suffix.size() && identity.size() <= 128 &&
        identity.compare(identity.size() - suffix.size(), suffix.size(), suffix) == 0 &&
        identity.find('@') == identity.size() - suffix.size() &&
        std::none_of(identity.begin(), identity.end(), [](unsigned char c) { return c == 0 || std::isspace(c); });
}
}
