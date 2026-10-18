;;;; The page's half of the REPL: dotcl-repl, on a terminal that is an xterm.
;;;;
;;;; The REPL is dotcl's own, unmodified. What this file supplies is the
;;;; terminal under it — where keys come from, where text goes, how wide the
;;;; screen is — and those live in Program.cs, because the page talks to C# and
;;;; this talks to the same queues from the other side.
;;;;
;;;; It runs on a thread of its own and blocks there waiting for a key, so it
;;;; needs the threaded build. Nothing is pushed to JavaScript: a thread that is
;;;; not the page thread cannot call into it, so what the REPL writes is
;;;; collected and the page comes and takes it, as for the editor.

(require "dotcl-gray")
(require "dotcl-repl")

(defpackage :repl-page
  (:use :cl)
  (:export #:start))

(in-package :repl-page)

(defun host (name &rest args)
  (apply #'dotnet:static "Playground" name args))

;;; What the REPL prints — the banner, values, errors, and whatever evaluated
;;; code writes to *standard-output* — goes to the same screen as the line
;;; editor's own drawing. The editor finishes this stream before each prompt,
;;; so the two do not interleave.

(defclass screen (dotcl-gray:fundamental-character-output-stream)
  ((column :initform 0 :accessor column)))

(defmethod dotcl-gray:stream-write-char ((s screen) ch)
  (host "ReplWrite" (string ch))
  (setf (column s) (if (char= ch #\Newline) 0 (1+ (column s))))
  ch)

(defmethod dotcl-gray:stream-write-string ((s screen) string &optional (start 0) end)
  (let* ((text (subseq string start end))
         (newline (position #\Newline text :from-end t)))
    (host "ReplWrite" text)
    (setf (column s) (if newline
                         (- (length text) newline 1)
                         (+ (column s) (length text)))))
  string)

(defmethod dotcl-gray:stream-line-column ((s screen))
  (column s))

(defvar *thread* nil)

(defun start ()
  "Start the REPL on a thread of its own, once. Returns \"ok\"."
  (unless *thread*
    (let ((terminal (dotcl-repl:make-terminal
                     :read-key (lambda () (host "ReplReadKey"))
                     :key-available-p (lambda () (host "ReplKeyAvailable"))
                     :write (lambda (string) (host "ReplWrite" string))
                     :width (lambda () (host "ReplWidth"))
                     :height (lambda () (host "ReplHeight"))))
          (screen (make-instance 'screen)))
      (setf *thread*
            (dotcl:make-thread
             (lambda ()
               ;; Ctrl+D on an empty line or ,quit ends a REPL. There is no
               ;; shell to return to here, so another one starts.
               (loop
                 (dotcl-repl:run-repl :terminal terminal :output screen :color t)
                 (host "ReplWrite" (format nil "~%[the REPL ended; starting another]~%"))))
             :name "repl"))))
  "ok")
