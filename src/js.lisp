;;;; JavaScript, from Lisp.
;;;;
;;;; Everything here stands on a few imported shim functions (js-bridge.js) and
;;;; nothing else. That is deliberate: [JSImport] is fixed at build time, so a
;;;; layer built out of one import per browser function could only ever call
;;;; what someone had thought of in advance. Reaching by name instead means this
;;;; file is where the vocabulary lives, and adding to it is editing Lisp.
;;;;
;;;; The names and what they mean are clysm's JS package (cxxxr/clysm,
;;;; runtime/js.lisp), so that code written for one runs on the other: GET is a
;;;; property, CALL a method, FUNCALL a function, NEW a constructor, and values
;;;; are converted the same way at the boundary (see Program.cs). Not here yet:
;;;; AWAIT and the rest of the asynchronous half, and modules.
;;;;
;;;; One difference that is not a gap but the threaded build: a Lisp function
;;;; handed to JavaScript runs later, on a thread of its own, and what it returns
;;;; is dropped. An event listener works; a function whose value JavaScript
;;;; wants — a map, a sort's comparison — does not.

(defpackage :js
  ;; Several of the names are CL's; the package that wins here is this one.
  (:use :cl)
  (:shadow #:get #:set #:funcall #:eval #:log #:array #:append)
  (:export #:global #:get #:set #:call #:new #:funcall #:eval #:typeof #:log
           #:to-lisp #:to-js #:array #:object #:js-value-p
           #:js-error #:js-error-value #:js-error-name #:js-error-message
           ;; this page's own, on top of those
           #:document #:body #:query #:element #:append #:text))

(in-package :js)

(define-condition js-error (error)
  ((value :initarg :value :reader js-error-value)
   (name :initarg :name :initform nil :reader js-error-name)
   (message :initarg :message :initform "" :reader js-error-message))
  (:report (lambda (condition stream)
             (format stream "JavaScript error: ~@[~A: ~]~A"
                     (js-error-name condition) (js-error-message condition))))
  (:documentation "A JavaScript exception thrown by a function called through
the JS package. VALUE is what was thrown (usually an Error), NAME and MESSAGE
its name and message."))

(defun host (name &rest args)
  (apply #'dotnet:static "Playground" name args))

(defvar *failure* (host "JsFailure")
  "What a call returns when JavaScript threw. The same object every time, so
EQ against it cannot be fooled by a value.")

(defun result (r)
  (if (eq r *failure*)
      (error 'js-error :value (host "JsThrown")
                       :name (host "JsThrownName")
                       :message (host "JsThrownMessage"))
      r))

(defun global (&optional name)
  "globalThis, or its property NAME. Everything else is reached from here."
  (if name (get (host "JsGlobal") name) (host "JsGlobal")))

(defun get (object key)
  "The property KEY of OBJECT."
  (result (host "JsGet" object key)))

(defun set (object key value)
  "Set the property KEY of OBJECT to VALUE, and return VALUE."
  (result (host "JsSet" object key value))
  value)

(defun call (object method &rest args)
  "Call the method METHOD of OBJECT with ARGS."
  (result (host "JsCall" object method args)))

(defun funcall (function &rest args)
  "Call the JavaScript FUNCTION with ARGS, with this undefined."
  (result (host "JsFuncall" function args)))

(defun new (constructor &rest args)
  "new CONSTRUCTOR(ARGS...)."
  (result (host "JsNew" constructor args)))

(defun eval (code) (funcall (global "eval") code))

(defun typeof (x)
  "What JavaScript's typeof says of X, as a keyword; :LISP for a Lisp value,
which is what every number, string and boolean is once it has crossed."
  (intern (string-upcase (host "JsTypeOf" x)) :keyword))

(defun js-value-p (x) (host "JsValueP" x))

(defun to-js (x)
  "X as JavaScript sees it. Only what stays JavaScript's on the way back — an
array, a function — is any different from X here."
  (host "JsToJs" x))

(defun to-lisp (o)
  "O as Lisp sees it. Values arrive converted already, so this is O."
  o)

(defun array (&rest items) (to-js (coerce items 'vector)))

(defun object (&rest plist)
  "A new object with the properties of PLIST: (js:object \"a\" 1 \"b\" 2)."
  (let ((o (new (global "Object"))))
    (loop for (key value) on plist by #'cddr do (set o key value))
    o))

(defun log (&rest args)
  (apply #'call (global "console") "log" args)
  nil)

;;; The little that is worth naming, for the pages here.

(defun document () (global "document"))
(defun body () (get (document) "body"))

(defun query (selector &optional (root (document)))
  "The first element matching SELECTOR, or NIL."
  (call root "querySelector" selector))

(defun element (tag) (call (document) "createElement" tag))

(defun append (parent child) (call parent "appendChild" child) child)

(defun text (object) (get object "textContent"))
(defun (setf text) (value object) (set object "textContent" value))
