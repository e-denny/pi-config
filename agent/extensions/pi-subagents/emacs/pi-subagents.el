;;; pi-subagents.el --- Live views of pi subagent runs -*- lexical-binding: t -*-

;; Copyright (C) 2026  Edgar

;; Author: Edgar
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: tools, processes, terminals
;; URL: https://github.com/earendil-works/pi

;;; Commentary:

;; Companion package for the pi-subagents pi extension.  When the user picks
;; an active subagent run, the extension calls `pi-subagents-open-run' through
;; `emacsclient --eval'.  This package starts the run's live viewer
;; (scripts/subagent-view.mjs) in a `term' buffer and displays it in the
;; running Emacs instance:
;;
;;   * `pi-subagents-display' `window' (the default) pops up a new window in
;;     the selected frame; `frame' opens a new frame; a function value is
;;     called with the buffer.
;;   * Keyboard focus stays where it was by default
;;     (`pi-subagents-select-window' nil), so the terminal running pi keeps
;;     receiving input.  Click the new window, or use your window command
;;     (`C-x o' from a normal buffer), to move to the view; in the viewer,
;;     `C-c o' returns to the previous window.
;;
;; Setup, in init.el -- the Emacs server is what lets the extension reach
;; this instance:
;;
;;   (require 'server)
;;   (unless (server-running-p)
;;     (server-start))
;;
;;   (add-to-list 'load-path
;;                (expand-file-name "~/.pi/agent/extensions/pi-subagents/emacs"))
;;   (require 'pi-subagents)
;;
;; The pi extension adds this directory to `load-path' itself if the feature
;; has not been loaded yet, so the explicit `require' is mainly for normal
;; startup and for editing the package with your usual Emacs tooling.

;;; Code:

(require 'term)
(require 'cl-lib)

(defgroup pi-subagents nil
  "Live views of pi subagent runs."
  :group 'tools
  :prefix "pi-subagents-")

(defcustom pi-subagents-display 'window
  "How `pi-subagents-open-run' displays a run buffer.

`window' pops up a new window in the selected frame, `frame' creates a new
frame, and a function is called with the buffer and should return the window
that displays it.

The pi extension can override this per call through its `emacsDisplay'
configuration; when it does not, this value applies."
  :type '(choice (const :tag "New window (split)" window)
                 (const :tag "New frame" frame)
                 (function :tag "Display function"))
  :group 'pi-subagents)

(defcustom pi-subagents-select-window nil
  "Whether to select the window showing a new run view.
The default nil keeps keyboard focus where it was (usually the terminal
running pi).  Set this to t to move to the view immediately."
  :type 'boolean
  :group 'pi-subagents)

(defcustom pi-subagents-scroll-to-bottom t
  "Whether run buffers follow new output.
When non-nil, each chunk of viewer output scrolls the window to the end,
matching the live status footer."
  :type 'boolean
  :group 'pi-subagents)

(defun pi-subagents--window-display-action ()
  "Return the display action for a new window in the selected frame."
  '((display-buffer-reuse-window display-buffer-pop-up-window)
    (inhibit-same-window . t)
    (reusable-frames . nil)))

(defun pi-subagents--frame-display-action ()
  "Return the display action for a new frame.
`inhibit-switch-frame' keeps keyboard focus in the terminal running pi."
  '((display-buffer-reuse-window display-buffer-pop-up-frame)
    (inhibit-switch-frame . t)
    (reusable-frames . nil)))

(defun pi-subagents--display (buffer display)
  "Display BUFFER according to DISPLAY and return its window, if any.
Fall back to the other strategy when the preferred one cannot create a
window (for example on a frame with no room to split)."
  (pcase display
    ('window
     (or (display-buffer buffer (pi-subagents--window-display-action))
         (display-buffer buffer (pi-subagents--frame-display-action))))
    ('frame
     (or (display-buffer buffer (pi-subagents--frame-display-action))
         (display-buffer buffer (pi-subagents--window-display-action))))
    ((pred functionp)
     (funcall display buffer))
    (_
     (user-error "pi-subagents: invalid display %S" display))))

(defun pi-subagents--start-term (buffer-name node viewer run-dir)
  "Start the live viewer in a term buffer and return the buffer.
BUFFER-NAME is passed to `make-term', which surrounds it with stars.  NODE,
VIEWER and RUN-DIR are the viewer's argv.  A buffer whose viewer process is
still alive is reused."
  (let* ((default-directory (file-name-as-directory run-dir))
         (buffer (make-term buffer-name node nil viewer run-dir)))
    (with-current-buffer buffer
      (setq-local term-scroll-to-bottom-on-output
                  (and pi-subagents-scroll-to-bottom t))
      (setq-local term-scroll-show-maximum-output pi-subagents-scroll-to-bottom)
      (setq-local truncate-lines nil))
    buffer))

;;;###autoload
(defun pi-subagents-open-run (buffer-name node viewer run-dir &optional display)
  "Open the live view of a pi subagent run.

BUFFER-NAME names the view buffer (no surrounding stars needed), NODE is the
Node executable, VIEWER is the absolute path of `subagent-view.mjs', and
RUN-DIR is the run's artifact directory (the directory containing
`status.json' and `output.log').  DISPLAY overrides `pi-subagents-display'
for this call.

Reopening a run reuses its term buffer while the viewer is alive; if the
viewer has exited, a fresh one starts and replays the run's output.  Return
the view buffer."
  (unless (and (stringp buffer-name) (stringp node)
               (stringp viewer) (stringp run-dir)
               (file-executable-p node)
               (file-readable-p viewer)
               (file-directory-p run-dir))
    (user-error "pi-subagents: invalid viewer arguments (node=%S viewer=%S run-dir=%S)"
                node viewer run-dir))
  (let* ((display (or display pi-subagents-display))
         (buffer (pi-subagents--start-term buffer-name node viewer run-dir))
         (window (pi-subagents--display buffer display)))
    (when (and pi-subagents-select-window window (window-live-p window))
      (select-window window))
    buffer))

(provide 'pi-subagents)
;;; pi-subagents.el ends here
