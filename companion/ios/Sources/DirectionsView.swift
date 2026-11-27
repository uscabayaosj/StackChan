import MapKit
import SwiftUI

struct LatestDirectionsView: View {
    let device: CompanionState
    let routeID: String
    @State private var route: CompanionRoute?
    @State private var unavailable = false
    @State private var problem: String?
    @State private var showMap = false
    @State private var attempt = 0
    @State private var completedAttempt: Int?

    var body: some View {
        Group {
            if !unavailable {
                Button {
                    if let route, route.expiresAt > .now { showMap = true }
                    else { attempt += 1 }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: route?.mode.symbol ?? "map")
                            .font(.title2).foregroundStyle(companionTint)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Latest directions").font(.subheadline).foregroundStyle(.secondary)
                            if let route {
                                Text(route.destination).font(.headline)
                                Text(route.summary).font(.subheadline).foregroundStyle(.secondary)
                            } else if let problem {
                                Text(problem).font(.subheadline)
                                Text("Try again").foregroundStyle(companionTint)
                            } else {
                                ProgressView().accessibilityLabel("Loading route")
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                    .multilineTextAlignment(.leading)
                    .padding(16)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .disabled(route == nil && problem == nil)
            }
        }
        .task(id: attempt) {
            guard completedAttempt != attempt, let client = device.client else { return }
            defer { if !Task.isCancelled { completedAttempt = attempt } }
            problem = nil
            do {
                let response: DirectionsResponse = try await client.get("directions")
                try Task.checkCancellation()
                guard device.client == client else { return }
                guard let latest = response.route, latest.id == routeID else {
                    problem = "The route isn’t available yet."
                    return
                }
                guard latest.expiresAt > .now else {
                    unavailable = true
                    return
                }
                route = latest
            } catch {
                if !Task.isCancelled, device.client == client { problem = error.localizedDescription }
            }
        }
        .task(id: route?.expiresAt) {
            guard let expiry = route?.expiresAt else { return }
            do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) }
            catch { return }
            showMap = false
            unavailable = true
            route = nil
        }
        .sheet(isPresented: $showMap) {
            if let route { RouteSheet(route: route) }
        }
    }
}

private extension RoutePoint {
    var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
}

private struct RouteSheet: View {
    let route: CompanionRoute
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var openFailed = false

    private var link: CompanionRoute.MapLink? {
        if #available(iOS 18.4, *) { return route.mapLink(unifiedAppleMaps: true) }
        return route.mapLink(unifiedAppleMaps: false)
    }

    var body: some View {
        NavigationStack {
            GeometryReader { size in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        let coordinates = route.path.map(\.coordinate)
                        if route.originPoint != nil || route.destinationPoint != nil || !coordinates.isEmpty {
                            Map {
                                if coordinates.count > 1 {
                                    MapPolyline(coordinates: coordinates).stroke(companionTint, lineWidth: 5)
                                }
                                if let point = route.originPoint {
                                    Marker(route.origin, systemImage: "circle", coordinate: point.coordinate).tint(.blue)
                                }
                                if let point = route.destinationPoint {
                                    Marker(route.destination, systemImage: "flag.fill", coordinate: point.coordinate).tint(companionTint)
                                }
                            }
                            .frame(height: max(160, min(size.size.height * 0.42, 380)))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .accessibilityLabel("Map from \(route.origin) to \(route.destination)")
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text(route.destination).font(.title2.bold()).accessibilityAddTraits(.isHeader)
                            Text("From \(route.origin)").font(.body)
                            Label(route.summary, systemImage: route.mode.symbol).font(.subheadline)
                            let usesOSM = route.source.localizedCaseInsensitiveContains("Valhalla")
                                || route.source.localizedCaseInsensitiveContains("OpenStreetMap")
                            let provider = usesOSM ? "Valhalla" :
                                route.source.localizedCaseInsensitiveContains("TfL") ? "Powered by TfL" : route.source
                            Text("\(provider) · \(route.createdAt.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption).foregroundStyle(.secondary)
                            if usesOSM {
                                Text("[© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) · [Improve the map](https://www.openstreetmap.org/fixthemap)")
                                    .font(.footnote)
                            }
                        }
                        if let link {
                            Button {
                                openURL(link.url) { opened in openFailed = !opened }
                            } label: {
                                Label("Open in \(link.name)", systemImage: "arrow.up.forward.app")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent).controlSize(.large)
                            Text("\(link.name) will calculate current directions for this journey.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        if openFailed { Text("The maps app couldn’t open the route.").font(.footnote).foregroundStyle(.red) }
                        if !route.steps.isEmpty {
                            Text("Directions").font(.headline).accessibilityAddTraits(.isHeader)
                            if let total = route.totalSteps, total > route.steps.count {
                                Text("Showing \(route.steps.count) of \(total) steps").font(.subheadline).foregroundStyle(.secondary)
                            }
                            ForEach(Array(route.steps.enumerated()), id: \.offset) { index, step in
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text("\(index + 1)").monospacedDigit().foregroundStyle(companionTint)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(step.instruction)
                                        if let distance = step.distanceMeters {
                                            Text(CompanionRoute.distance(distance)).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            }
            .navigationTitle("Route overview")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
