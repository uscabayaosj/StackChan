import SwiftUI

enum SaoirseTheme {
    static let canvas = adaptive(light: 0xF8F0E7, dark: 0x201713)
    static let surface = adaptive(light: 0xFFFAF4, dark: 0x30231C)
    static let action = adaptive(light: 0x155B90, dark: 0x8ACFFF)
    static let stage = color(0x2B180F)
    static let stageText = color(0xFFF2E2)
    static let stageSecondary = color(0xE9D0BB)
    static let stageStatus = color(0x8ACFFF)
    static let live = color(0x9E2337)
    static let inset: CGFloat = 24
    static let radius: CGFloat = 16

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            uiColor(traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    private static func color(_ rgb: UInt32) -> Color { Color(uiColor: uiColor(rgb)) }

    private static func uiColor(_ rgb: UInt32) -> UIColor {
        UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255,
                green: CGFloat((rgb >> 8) & 0xFF) / 255,
                blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

extension View {
    func saoirseCanvas() -> some View {
        background(SaoirseTheme.canvas.ignoresSafeArea())
    }

    func saoirseGroupedCanvas() -> some View {
        scrollContentBackground(.hidden).saoirseCanvas()
    }
}
