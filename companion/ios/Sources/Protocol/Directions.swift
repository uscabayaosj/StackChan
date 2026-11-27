import Foundation

struct DirectionsResponse: Decodable {
    let route: CompanionRoute?
}

struct RoutePoint: Equatable {
    let latitude: Double
    let longitude: Double

    init?(_ pair: [Double]?) {
        guard let pair, pair.count == 2, (-90...90).contains(pair[0]), (-180...180).contains(pair[1]) else {
            return nil
        }
        latitude = pair[0]
        longitude = pair[1]
    }

    var queryValue: String { "\(latitude),\(longitude)" }
}

struct CompanionRoute: Decodable, Identifiable {
    enum Mode: String, Decodable {
        case walk, cycle, drive, transit

        var label: String {
            switch self { case .walk: "Walking"; case .cycle: "Cycling"; case .drive: "Driving"; case .transit: "Transit" }
        }

        var symbol: String {
            switch self { case .walk: "figure.walk"; case .cycle: "bicycle"; case .drive: "car"; case .transit: "tram" }
        }
    }

    struct Step: Decodable {
        let instruction: String
        let distanceMeters: Double?
    }

    let id: String
    let createdAt: Date
    let expiresAt: Date
    let origin: String
    let destination: String
    let mode: Mode
    let distanceMeters: Double?
    let durationMinutes: Double
    let steps: [Step]
    let totalSteps: Int?
    let source: String
    private let originCoordinate: [Double]?
    private let destinationCoordinate: [Double]?
    private let geometry: [[Double]]?

    var path: [RoutePoint] {
        guard let geometry, geometry.count >= 2 else { return [] }
        let points = geometry.compactMap(RoutePoint.init)
        return points.count == geometry.count ? points : []
    }

    var originPoint: RoutePoint? { RoutePoint(originCoordinate) ?? RoutePoint(geometry?.first) }
    var destinationPoint: RoutePoint? { RoutePoint(destinationCoordinate) ?? RoutePoint(geometry?.last) }

    var summary: String {
        var fields = [mode.label, "\(durationMinutes.formatted(.number.precision(.fractionLength(0)))) min"]
        if let distanceMeters { fields.append(Self.distance(distanceMeters)) }
        return fields.joined(separator: " · ")
    }

    static func distance(_ meters: Double) -> String {
        Measurement(value: meters, unit: UnitLength.meters)
            .formatted(.measurement(width: .abbreviated, usage: .road))
    }

    struct MapLink {
        let name: String
        let url: URL
    }

    func mapLink(unifiedAppleMaps: Bool) -> MapLink? {
        let start = originPoint?.queryValue ?? origin.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = destinationPoint?.queryValue ?? destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !start.isEmpty, !end.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = "maps.apple.com"
        var name = "Apple Maps"
        if unifiedAppleMaps {
            components.path = "/directions"
            let travel: String = switch mode {
                case .walk: "walking"; case .cycle: "cycling"; case .drive: "driving"; case .transit: "transit"
            }
            components.queryItems = [.init(name: "source", value: start), .init(name: "destination", value: end),
                                     .init(name: "mode", value: travel)]
        } else if mode == .cycle {
            name = "Google Maps"
            components.host = "www.google.com"
            components.path = "/maps/dir/"
            components.queryItems = [.init(name: "api", value: "1"), .init(name: "origin", value: start),
                                     .init(name: "destination", value: end), .init(name: "travelmode", value: "bicycling")]
        } else {
            components.path = "/"
            let flag = mode == .walk ? "w" : mode == .drive ? "d" : "r"
            components.queryItems = [.init(name: "saddr", value: start), .init(name: "daddr", value: end),
                                     .init(name: "dirflg", value: flag)]
        }
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url.map { MapLink(name: name, url: $0) }
    }
}
