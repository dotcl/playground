;;;; JavaScript, from Lisp.
;;;;
;;;; Everything here stands on five imported shim functions (js-bridge.js) and
;;;; nothing else. That is deliberate: [JSImport] is fixed at build time, so a
;;;; layer built out of one import per browser function could only ever call
;;;; what someone had thought of in advance. Reaching by name instead means this
;;;; file is where the vocabulary lives, and adding to it is editing Lisp.
;;;;
;;;; The shape follows ClojureScript's split — a property is not a method, and
;;;; saying so in the syntax keeps both readable.

(defpackage :js
  ;; APPEND and LOG are CL's; the DOM wants both names and the package that
  ;; wins here is this one.
  (:use :cl)
  (:shadow #:append #:log)
  (:export #:global #:ref #:call #:document #:body #:query #:element
           #:append #:text #:on #:log))

(in-package :js)

(defun global ()
  "globalThis. Everything else is reached from here."
  (dotnet:static "Playground" "JsGlobal"))

(defun ref (object name)
  "The property NAME of OBJECT."
  (dotnet:static "Playground" "JsGet" object name))

(defun (setf ref) (value object name)
  (dotnet:static "Playground" "JsSet" object name value)
  value)

(defun call (object name &rest args)
  "Call the method NAME on OBJECT. Up to six arguments: the import signatures
have to be fixed at build time, and six is what arc takes. Anything wider —
drawImage takes nine — wants its own shim rather than another arity."
  (let ((a (first args)) (b (second args)) (c (third args))
        (d (fourth args)) (e (fifth args)) (f (sixth args)))
    (case (length args)
      (0 (dotnet:static "Playground" "JsCall" object name))
      (1 (dotnet:static "Playground" "JsCall" object name a))
      (2 (dotnet:static "Playground" "JsCall" object name a b))
      (3 (dotnet:static "Playground" "JsCall" object name a b c))
      (4 (dotnet:static "Playground" "JsCall" object name a b c d))
      (5 (dotnet:static "Playground" "JsCall" object name a b c d e))
      (6 (dotnet:static "Playground" "JsCall" object name a b c d e f))
      (t (error "js:call takes at most six arguments, got ~d" (length args))))))

;;; The little that is worth naming.

(defun document () (ref (global) "document"))
(defun body () (ref (document) "body"))

(defun query (selector &optional (root (document)))
  "The first element matching SELECTOR, or NIL."
  (call root "querySelector" selector))

(defun element (tag) (call (document) "createElement" tag))

(defun append (parent child) (call parent "appendChild" child) child)

(defun text (object) (ref object "textContent"))
(defun (setf text) (value object) (setf (ref object "textContent") value))

(defun log (format-string &rest args)
  (call (ref (global) "console") "log" (apply #'format nil format-string args)))
