// The composer's Photos button opens the photo library (PHPicker) through
// tauri-plugin-dialog, which presents it full screen. This turns that one
// presentation into a sheet over the lower ~45% of the screen, as
// Messenger's photo tray is: the chat stays in view, and a drag up (or a
// scroll past the top row) grows it to full height. The plugin still copies
// the picks into the sandbox and adds them to the fs scope.
//
// Installed once from the Rust shell's setup (`lib.rs`); compiled into the
// app target by `scripts/patch-ios-widget.sh`.

import ObjectiveC
import PhotosUI
import UIKit

private var photoSheetInstalled = false
private var photoSheetProxyKey: UInt8 = 0

@_cdecl("openagentd_photo_sheet_install")
public func openagentdPhotoSheetInstall() {
  guard !photoSheetInstalled else { return }
  photoSheetInstalled = true
  // The plugin sets `.fullScreen` right before `present`, so the style can
  // only be changed at `present` itself; only PHPicker is touched there.
  guard
    let original = class_getInstanceMethod(
      UIViewController.self, #selector(UIViewController.present(_:animated:completion:))),
    let replacement = class_getInstanceMethod(
      UIViewController.self, #selector(UIViewController.oaPresent(_:animated:completion:)))
  else { return }
  method_exchangeImplementations(original, replacement)
}

extension UIViewController {
  @objc fileprivate func oaPresent(
    _ presented: UIViewController, animated: Bool, completion: (() -> Void)?
  ) {
    if let picker = presented as? PHPickerViewController { PhotoSheet.prepare(picker) }
    // Exchanged: this calls UIKit's own `present`.
    oaPresent(presented, animated: animated, completion: completion)
  }
}

private enum PhotoSheet {
  static func prepare(_ picker: PHPickerViewController) {
    picker.modalPresentationStyle = .pageSheet
    if let sheet = picker.sheetPresentationController {
      if #available(iOS 16, *) {
        let tray = UISheetPresentationController.Detent.custom(
          identifier: .init("openagentd.photos")
        ) { context in context.maximumDetentValue * 0.45 }
        sheet.detents = [tray, .large()]
      } else {
        sheet.detents = [.medium(), .large()]
      }
      sheet.prefersGrabberVisible = true
      sheet.prefersScrollingExpandsWhenScrolledToEdge = true
    }
    // A sheet can be swiped away, which a full-screen picker could not be.
    // The proxy answers the plugin once either way: the picker's own result,
    // or "nothing picked" when the sheet is swiped down.
    let proxy = PhotoSheetProxy(target: picker.delegate)
    picker.delegate = proxy
    picker.presentationController?.delegate = proxy
    objc_setAssociatedObject(picker, &photoSheetProxyKey, proxy, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
  }
}

private final class PhotoSheetProxy: NSObject, PHPickerViewControllerDelegate,
  UIAdaptivePresentationControllerDelegate
{
  private weak var target: PHPickerViewControllerDelegate?
  private var answered = false

  init(target: PHPickerViewControllerDelegate?) {
    self.target = target
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    guard !answered else { return }
    answered = true
    target?.picker(picker, didFinishPicking: results)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    guard let picker = presentationController.presentedViewController as? PHPickerViewController
    else { return }
    self.picker(picker, didFinishPicking: [])
  }
}
