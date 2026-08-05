;;;; The page's half of the editor.
;;;;
;;;; Lem's server frontend is a separate program that speaks JSON-RPC over a
;;;; socket. Here it is the same image as the page, so the transport under it is
;;;; jsonrpc's in-process one: the editor writes messages to a function instead
;;;; of a file descriptor, and this file is that function.
;;;;
;;;; Nothing is pushed to JavaScript. The editor runs on its own thread, and a
;;;; thread that is not the page thread cannot call into JavaScript at all — so
;;;; the drawing is collected here and the page comes and takes it. That also
;;;; makes a frame one call instead of one per drawing operation, and a redraw
;;;; is hundreds of them.
;;;;
;;;; Carried only when asked for; see LemPage in the .csproj.

(defpackage :lem-page
  (:use :cl)
  (:export #:start #:drain #:deliver-message))

(in-package :lem-page)

(defvar *pending* '() "Messages from the editor, newest first.")
(defvar *lock* (bordeaux-threads:make-lock))
(defvar *transport* nil "Non-nil once the editor is up and logged into.")

;; ASCII unit separator, as in prelude.lisp: it cannot occur in the JSON the
;; editor writes, so the page can split a batch without an escaping scheme.
(defvar *separator* (string (code-char 31)))

(defun record (json)
  (bordeaux-threads:with-lock-held (*lock*) (push json *pending*)))

(defun drain ()
  "Everything the editor has said since the last call, oldest first."
  (let ((messages (bordeaux-threads:with-lock-held (*lock*)
                    (prog1 (nreverse *pending*) (setf *pending* '())))))
    (with-output-to-string (out)
      (loop for message in messages
            for first = t then nil
            do (unless first (write-string *separator* out))
               (write-string message out)))))

(defun deliver-message (json)
  "Hand one JSON-RPC message to the editor, as a socket would."
  (when *transport*
    (jsonrpc/transport/in-process:deliver-json *transport* json)
    t))

(defun transport ()
  (jsonrpc/base:jsonrpc-transport
   (lem-server::jsonrpc-server (lem:implementation))))

(defun wait-until (predicate &key (seconds 60))
  (loop repeat (round (/ seconds 0.05))
        when (funcall predicate) return t
        do (sleep 0.05)))

(defun start (width height)
  "Start the editor and log in as its frontend. Returns \"ok\", or why not.

The editor blocks its own thread until a login arrives — that is how it works
under any runner — so the thread is started first and the handshake follows."
  (if *transport*
      "ok"
      (progn
        (bordeaux-threads:make-thread
         (lambda ()
           (handler-case
               (lem-server:run-in-process-server :writer #'record :json-out t)
             (error (e)
               ;; Reported as a message rather than signalled: by the time this
               ;; runs, nobody is waiting on this thread to return anything.
               (record (format nil "{\"jsonrpc\":\"2.0\",\"method\":\"page-error\",~
                                     \"params\":{\"message\":~s}}"
                               (princ-to-string e))))))
         :name "lem editor")
        ;; lem:implementation reads an unbound variable until the editor sets
        ;; it, so the whole lookup has to be guarded, not just the transport.
        (if (wait-until (lambda () (ignore-errors (transport))))
            (progn
              (setf *transport* (transport))
              (deliver-message
               (format nil "{\"jsonrpc\":\"2.0\",\"method\":\"login\",\"id\":1,~
                            \"params\":{\"size\":{\"width\":~d,\"height\":~d},~
                            \"foreground\":\"#dcdcdc\",\"background\":\"#1e1e28\"}}"
                       width height))
              ;; Login is answered on the request path, which works with no
              ;; connection registered at all. Drawing goes out through
              ;; broadcast, and only a redraw starts it.
              (deliver-message
               (format nil "{\"jsonrpc\":\"2.0\",\"method\":\"redraw\",\"id\":2,~
                            \"params\":{\"size\":{\"width\":~d,\"height\":~d}}}"
                       width height))
              "ok")
            "the editor never brought a transport up"))))
