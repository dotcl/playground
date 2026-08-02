;;;; Loaded once, right after the core boots. Everything the page asks of the
;;;; Lisp side goes through PLAYGROUND:RUN.
;;;;
;;;; Blocks share one image on purpose: a tutorial wants chapter 7 to use what
;;;; chapter 2 defined. The page is responsible for replaying earlier blocks when
;;;; a reader arrives in the middle.

(defpackage :playground
  (:use :cl)
  (:export #:run))

(in-package :playground)

;; ASCII unit separator. Cannot occur in Lisp source, so the page can split on
;; it without any escaping scheme.
(defvar *sep* (string (code-char 31)))

(defun describe-restarts (c)
  "Names of the restarts available while C is being signalled, most recent first.
Anonymous restarts are dropped — there is nothing to show for them."
  (remove nil (mapcar #'restart-name (compute-restarts c))))

(defun run (source)
  "Read and evaluate SOURCE one form at a time, as LOAD would.

Reading form-by-form (rather than reading everything first) is what lets a single
block contain DEFPACKAGE followed by IN-PACKAGE followed by symbols in the new
package — the reader must not run ahead of the evaluator.

Returns status, printed output, values, condition type, condition report and
available restarts, joined by *SEP*."
  (let ((out (make-string-output-stream))
        (values-out '())
        (restarts '())
        (err nil))
    (handler-case
        ;; Inner, so it runs before HANDLER-CASE unwinds and the restarts are
        ;; still established. Showing them is the point: recovering from an error
        ;; is the thing a subset implementation cannot demonstrate.
        (handler-bind ((error (lambda (c) (setf restarts (describe-restarts c)))))
          (let ((*standard-output* out)
                (*error-output* out)
                (*trace-output* out))
            (with-input-from-string (in source)
              (loop for form = (read in nil in) until (eq form in)
                    do (setf values-out (multiple-value-list (eval form)))))))
      (error (c) (setf err c)))
    (flet ((safe (thunk fallback)
             (handler-case (funcall thunk) (error () fallback))))
      (format nil "~a~a~a~a~a~a~a~a~a~a~a"
              (if err "error" "ok")
              *sep* (get-output-stream-string out)
              *sep* (if err
                        ""
                        (format nil "~{~a~^~%~}"
                                (mapcar (lambda (v)
                                          (safe (lambda () (prin1-to-string v))
                                                "#<unprintable>"))
                                        values-out)))
              *sep* (if err (safe (lambda () (format nil "~a" (type-of err))) "ERROR") "")
              *sep* (if err (safe (lambda () (princ-to-string err))
                                  "<the condition could not be printed>")
                        "")
              *sep* (format nil "~{~a~^ ~}" restarts)))))
