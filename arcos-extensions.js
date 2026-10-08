(function () {
  'use strict';

  // ============================================================
  // ARCOS FILE UPLOAD EXTENSIONS
  // ============================================================
  //
  // Browser-side only.
  //
  // Responsibilities:
  //   1. Let the client select exactly one file.
  //   2. Perform UX-level validation.
  //   3. Return file metadata to Voiceflow.
  //   4. Receive the backend-generated signed GCS PUT URL.
  //   5. Upload the browser File directly to GCS.
  //   6. Return upload completion/failure to Voiceflow.
  //
  // SECURITY:
  //   No ARCOS secrets, API keys, Airtable PATs, or verification
  //   tokens are stored in this file.
  //
  // The backend remains authoritative for all security and upload
  // validation. Client-side checks are for user experience only.
  // ============================================================

  var ARCOS_EXTENSION_VERSION = '1.0.0';

  // ------------------------------------------------------------
  // Shared browser state
  // ------------------------------------------------------------

  window.__ARCOS_UPLOAD_STATE = window.__ARCOS_UPLOAD_STATE || {
    selectedFile: null,
    selectionToken: 0,
    activeUploadId: null
  };

  var state = window.__ARCOS_UPLOAD_STATE;

  // ------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------

  var DOCUMENT_TYPES = ['JPG', 'JPEG', 'HEIC', 'PDF'];
  var VIDEO_TYPES = ['MP4', 'MOV'];

  var MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
  var MAX_VIDEO_BYTES = 512 * 1024 * 1024;
  var MAX_VIDEO_SECONDS = 180;

  var CONTENT_TYPES = {
    JPG: 'image/jpeg',
    JPEG: 'image/jpeg',
    HEIC: 'image/heic',
    PDF: 'application/pdf',
    MP4: 'video/mp4',
    MOV: 'video/quicktime'
  };

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  function getExtension(fileName) {
    var parts = String(fileName || '').toLowerCase().split('.');

    if (parts.length < 2) {
      return '';
    }

    return parts.pop();
  }

  function normalizeFileType(fileName) {
    var extension = getExtension(fileName);

    var types = {
      jpg: 'JPG',
      jpeg: 'JPEG',
      heic: 'HEIC',
      pdf: 'PDF',
      mp4: 'MP4',
      mov: 'MOV'
    };

    return types[extension] || '';
  }

  function getCanonicalContentType(normalizedType) {
    return CONTENT_TYPES[normalizedType] || 'application/octet-stream';
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) {
      return 'Unknown size';
    }

    if (bytes < 1024) {
      return bytes + ' B';
    }

    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + ' KB';
    }

    if (bytes < 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function setStatus(element, message) {
    if (element) {
      element.textContent = message;
    }
  }

  function clearErrors(container) {
    var errors = container.querySelectorAll('.arcos-error');

    for (var i = 0; i < errors.length; i += 1) {
      errors[i].remove();
    }
  }

  function buildError(message) {
    var error = document.createElement('div');

    error.className = 'arcos-error';
    error.style.marginTop = '8px';
    error.style.padding = '10px';
    error.style.borderRadius = '8px';
    error.style.fontSize = '13px';
    error.style.lineHeight = '1.4';
    error.style.background = '#fff1f1';
    error.style.border = '1px solid #f0b8b8';
    error.style.color = '#7a1f1f';
    error.textContent = message;

    return error;
  }

  // ------------------------------------------------------------
  // Voiceflow event bridge
  // ------------------------------------------------------------
  //
  // ARCOS Function Tools listen for specific event types such as:
  //
  //   file_selected
  //   file_cancelled
  //   upload_complete
  //   upload_failed
  //
  // The event name is stored in `arcos_event` and is also sent
  // as the actual Voiceflow interaction `type`.
  //
  // This is necessary so the Function Tool listener can match:
  //
  //   event.type === 'file_selected'
  //
  // instead of receiving:
  //
  //   event.type === 'complete'
  //
  // with `file_selected` buried inside the payload.
  // ------------------------------------------------------------

  function sendVoiceflowEvent(payload) {
    if (
      !window.voiceflow ||
      !window.voiceflow.chat ||
      typeof window.voiceflow.chat.interact !== 'function'
    ) {
      console.error('ARCOS: Voiceflow chat API is unavailable.');
      return false;
    }

    var eventPayload = payload || {};
    var eventType = eventPayload.arcos_event || 'complete';

    window.voiceflow.chat.interact({
      type: eventType,
      payload: eventPayload
    });

    return true;
  }

  function setControlsDisabled(buttons, disabled) {
    for (var i = 0; i < buttons.length; i += 1) {
      if (!buttons[i]) {
        continue;
      }

      buttons[i].disabled = disabled;

      buttons[i].style.opacity = disabled
        ? '0.55'
        : (
            buttons[i].classList.contains('arcos-cancel-button')
              ? '0.75'
              : '1'
          );
    }
  }

  function readVideoDuration(file) {
    return new Promise(function (resolve) {
      var objectUrl = URL.createObjectURL(file);
      var video = document.createElement('video');
      var settled = false;

      function finish(value) {
        if (settled) {
          return;
        }

        settled = true;

        try {
          URL.revokeObjectURL(objectUrl);
        } catch (error) {
          // Ignore cleanup errors.
        }

        video.removeAttribute('src');
        video.load();
        resolve(value);
      }

      video.preload = 'metadata';

      video.onloadedmetadata = function () {
        var duration = video.duration;

        if (!Number.isFinite(duration)) {
          finish(null);
          return;
        }

        finish(duration);
      };

      video.onerror = function () {
        finish(null);
      };

      // Prevent a malformed video from leaving the selector
      // waiting indefinitely.
      setTimeout(function () {
        finish(null);
      }, 10000);

      video.src = objectUrl;
    });
  }

  // ------------------------------------------------------------
  // Client-side validation
  // ------------------------------------------------------------

  async function validateSelectedFile(file, isEvidence) {
    if (!file) {
      return {
        valid: false,
        message: 'No file was selected.'
      };
    }

    if (!Number.isFinite(file.size) || file.size <= 0) {
      return {
        valid: false,
        message: 'That file appears to be empty. Please choose another file.'
      };
    }

    var normalizedType = normalizeFileType(file.name);

    if (!normalizedType) {
      return {
        valid: false,
        message: 'That file type is not supported.'
      };
    }

    // ----------------------------------------------------------
    // Medical Documentation
    // ----------------------------------------------------------

    if (!isEvidence) {
      if (!DOCUMENT_TYPES.includes(normalizedType)) {
        return {
          valid: false,
          message: 'Please choose a JPG, JPEG, HEIC, or PDF file.'
        };
      }

      if (file.size > MAX_DOCUMENT_BYTES) {
        return {
          valid: false,
          message: 'That file is larger than the 50 MB limit.'
        };
      }

      return {
        valid: true,
        normalizedType: normalizedType
      };
    }

    // ----------------------------------------------------------
    // Evidence: photo/document
    // ----------------------------------------------------------

    if (DOCUMENT_TYPES.includes(normalizedType)) {
      if (file.size > MAX_DOCUMENT_BYTES) {
        return {
          valid: false,
          message: 'That file is larger than the 50 MB limit.'
        };
      }

      return {
        valid: true,
        normalizedType: normalizedType
      };
    }

    // ----------------------------------------------------------
    // Evidence: video
    // ----------------------------------------------------------

    if (VIDEO_TYPES.includes(normalizedType)) {
      if (file.size > MAX_VIDEO_BYTES) {
        return {
          valid: false,
          message: 'That video is larger than the 512 MB limit.'
        };
      }

      var duration = await readVideoDuration(file);

      if (duration === null) {
        return {
          valid: false,
          message:
            'That video could not be read. Please choose another MP4 or MOV file.'
        };
      }

      if (duration > MAX_VIDEO_SECONDS) {
        return {
          valid: false,
          message:
            'That video is longer than the 180-second limit.'
        };
      }

      return {
        valid: true,
        normalizedType: normalizedType,
        duration: duration
      };
    }

    return {
      valid: false,
      message: 'That file type is not supported.'
    };
  }

  // ============================================================
  // ARCOS FILE SELECTION EXTENSION
  // ============================================================

  window.ARCOSFileSelectionExtension = {
    name: 'ARCOSFileSelection',
    type: 'response',

    match: function (args) {
      var trace = args && args.trace ? args.trace : {};
      var payload = trace.payload || {};

      return (
        trace.type === 'ARCOS_File_Selection' ||
        payload.name === 'ARCOS_File_Selection'
      );
    },

    render: function (args) {
      var trace = args && args.trace ? args.trace : {};
      var element = args && args.element ? args.element : null;
      var payload = trace.payload || {};

      if (!element) {
        return;
      }

      var fileCategory = String(
        payload.file_category ||
        payload.fileCategory ||
        ''
      ).trim().toLowerCase();

      var isEvidence = fileCategory === 'evidence';

      var container = document.createElement('div');

      container.style.width = '100%';
      container.style.boxSizing = 'border-box';

      // ----------------------------------------------------------
      // UI
      // ----------------------------------------------------------

      container.innerHTML =
        '<div ' +
          'class="arcos-upload-card" ' +
          'style="' +
            'display:flex;' +
            'flex-direction:column;' +
            'gap:10px;' +
            'padding:14px;' +
            'border:1px solid rgba(0,0,0,0.12);' +
            'border-radius:10px;' +
            'background:#ffffff;' +
            'box-sizing:border-box;' +
          '"' +
        '>' +

          '<div style="font-size:14px;font-weight:600;">' +
            (
              isEvidence
                ? 'How would you like to upload your evidence?'
                : 'Choose your medical document'
            ) +
          '</div>' +

          '<button ' +
            'type="button" ' +
            'class="arcos-photo-document-button" ' +
            'style="' +
              'width:100%;' +
              'padding:11px 14px;' +
              'border:1px solid rgba(0,0,0,0.15);' +
              'border-radius:8px;' +
              'background:#ffffff;' +
              'cursor:pointer;' +
              'font-size:14px;' +
            '"' +
          '>' +
            'Choose a photo or document' +
          '</button>' +

          (
            isEvidence
              ? (
                  '<button ' +
                    'type="button" ' +
                    'class="arcos-video-button" ' +
                    'style="' +
                      'width:100%;' +
                      'padding:11px 14px;' +
                      'border:1px solid rgba(0,0,0,0.15);' +
                      'border-radius:8px;' +
                      'background:#ffffff;' +
                      'cursor:pointer;' +
                      'font-size:14px;' +
                    '"' +
                  '>' +
                    'Choose a video' +
                  '</button>'
                )
              : ''
          ) +

          '<button ' +
            'type="button" ' +
            'class="arcos-cancel-button" ' +
            'style="' +
              'width:100%;' +
              'padding:8px 12px;' +
              'border:none;' +
              'background:transparent;' +
              'cursor:pointer;' +
              'font-size:13px;' +
              'opacity:0.75;' +
            '"' +
          '>' +
            'Cancel' +
          '</button>' +

          '<div ' +
            'class="arcos-status" ' +
            'style="' +
              'font-size:12px;' +
              'line-height:1.4;' +
              'opacity:0.75;' +
            '"' +
          '></div>' +

        '</div>';

      // ----------------------------------------------------------
      // Elements
      // ----------------------------------------------------------

      var photoDocumentButton =
        container.querySelector(
          '.arcos-photo-document-button'
        );

      var videoButton =
        container.querySelector(
          '.arcos-video-button'
        );

      var cancelButton =
        container.querySelector(
          '.arcos-cancel-button'
        );

      var statusElement =
        container.querySelector(
          '.arcos-status'
        );

      // ----------------------------------------------------------
      // Hidden file inputs
      // ----------------------------------------------------------

      var photoDocumentInput =
        document.createElement('input');

      photoDocumentInput.type = 'file';

      photoDocumentInput.accept =
        '.jpg,.jpeg,.heic,.pdf,' +
        'image/jpeg,image/heic,application/pdf';

      photoDocumentInput.style.display = 'none';

      var videoInput =
        document.createElement('input');

      videoInput.type = 'file';

      videoInput.accept =
        '.mp4,.mov,video/mp4,video/quicktime';

      videoInput.style.display = 'none';

      container.appendChild(
        photoDocumentInput
      );

      if (isEvidence && videoButton) {
        container.appendChild(
          videoInput
        );
      }

      // ----------------------------------------------------------
      // Controls
      // ----------------------------------------------------------

      function disableControls() {
        setControlsDisabled(
          [
            photoDocumentButton,
            videoButton,
            cancelButton
          ],
          true
        );
      }

      function enableControls() {
        setControlsDisabled(
          [
            photoDocumentButton,
            videoButton,
            cancelButton
          ],
          false
        );
      }

      // ----------------------------------------------------------
      // File selection
      // ----------------------------------------------------------

      async function handleFileSelection(file) {
        if (!file) {
          return;
        }

        clearErrors(container);

        disableControls();

        setStatus(
          statusElement,
          'Checking the selected file...'
        );

        var validation =
          await validateSelectedFile(
            file,
            isEvidence
          );

        if (!validation.valid) {
          state.selectedFile = null;

          clearErrors(container);

          var uploadCard =
            container.querySelector(
              '.arcos-upload-card'
            );

          if (uploadCard) {
            uploadCard.appendChild(
              buildError(
                validation.message
              )
            );
          }

          enableControls();

          setStatus(
            statusElement,
            'Please choose another file.'
          );

          return;
        }

        // Store the actual browser File object locally.
        //
        // It is NOT serialized into Voiceflow variables and
        // is NOT sent to the ARCOS backend API.
        state.selectedFile = file;

        state.selectionToken += 1;

        var selectionToken =
          state.selectionToken;

        setStatus(
          statusElement,
          file.name +
            ' selected (' +
            formatFileSize(file.size) +
            ').'
        );

        // Return metadata to Voiceflow.
        //
        // `sendVoiceflowEvent()` sends `file_selected` as the
        // actual Voiceflow interaction type.
        sendVoiceflowEvent({
          arcos_event: 'file_selected',
          file_category: fileCategory,
          file_name: file.name,
          file_type: validation.normalizedType,
          file_size: file.size,
          selection_token: selectionToken
        });
      }

      // ----------------------------------------------------------
      // File chooser: photo/document
      // ----------------------------------------------------------

      photoDocumentButton.addEventListener(
        'click',
        function () {
          photoDocumentInput.value = '';
          photoDocumentInput.click();
        }
      );

      photoDocumentInput.addEventListener(
        'change',
        function () {
          var file =
            photoDocumentInput.files &&
            photoDocumentInput.files[0];

          handleFileSelection(file);
        }
      );

      // ----------------------------------------------------------
      // File chooser: video
      // ----------------------------------------------------------

      if (videoButton) {
        videoButton.addEventListener(
          'click',
          function () {
            videoInput.value = '';
            videoInput.click();
          }
        );

        videoInput.addEventListener(
          'change',
          function () {
            var file =
              videoInput.files &&
              videoInput.files[0];

            handleFileSelection(file);
          }
        );
      }

      // ----------------------------------------------------------
      // Cancel
      // ----------------------------------------------------------

      cancelButton.addEventListener(
        'click',
        function () {
          state.selectedFile = null;

          state.selectionToken += 1;

          photoDocumentInput.value = '';

          if (videoInput) {
            videoInput.value = '';
          }

          setStatus(
            statusElement,
            'Upload cancelled.'
          );

          disableControls();

          // NOTE:
          // This intentionally remains `cancelled` for now.
          // The Voiceflow Function Tool currently listens for
          // `file_cancelled`. We will fix that separately after
          // the successful file-selection path is confirmed.
          sendVoiceflowEvent({
            arcos_event: 'cancelled',
            file_category: fileCategory
          });
        }
      );

      element.appendChild(container);
    }
  };

  // ============================================================
  // ARCOS FILE UPLOAD EXTENSION
  // ============================================================

  window.ARCOSFileUploadExtension = {
    name: 'ARCOSFileUpload',
    type: 'response',

    match: function (args) {
      var trace = args && args.trace ? args.trace : {};
      var payload = trace.payload || {};

      return (
        trace.type === 'ext_arcos_file_upload' ||
        payload.name === 'ext_arcos_file_upload'
      );
    },

    render: function (args) {
      var trace = args && args.trace ? args.trace : {};
      var element = args && args.element ? args.element : null;
      var payload = trace.payload || {};

      if (!element) {
        return;
      }

      var uploadId =
        String(
          payload.upload_id || ''
        ).trim();

      var temporaryUploadUrl =
        String(
          payload.temporary_upload_url || ''
        ).trim();

      var expectedFileType =
        String(
          payload.file_type || ''
        )
          .trim()
          .toUpperCase();

      var expectedFileSize =
        Number(
          payload.file_size
        );

      var container =
        document.createElement('div');

      container.style.padding =
        '12px 0';

      var status =
        document.createElement('div');

      status.textContent =
        'Uploading your file securely...';

      status.style.fontSize =
        '13px';

      status.style.lineHeight =
        '1.5';

      container.appendChild(status);

      element.appendChild(container);

      // ----------------------------------------------------------
      // Prevent duplicate upload attempts.
      // ----------------------------------------------------------

      if (
        uploadId &&
        state.activeUploadId === uploadId
      ) {
        status.textContent =
          'Your file upload is already in progress.';

        return;
      }

      if (uploadId) {
        state.activeUploadId =
          uploadId;
      }

      var file =
        state.selectedFile;

      var selectionTokenAtUploadStart =
        state.selectionToken;

      // ----------------------------------------------------------
      // Failure handler
      // ----------------------------------------------------------

      function failUpload(
        message,
        extraPayload
      ) {
        status.textContent =
          message;

        if (
          uploadId &&
          state.activeUploadId === uploadId
        ) {
          state.activeUploadId = null;
        }

        // Do not destroy a newer selection made by
        // a later submission.
        if (
          state.selectionToken ===
          selectionTokenAtUploadStart
        ) {
          state.selectedFile = null;
        }

        sendVoiceflowEvent(
          Object.assign(
            {
              arcos_event:
                'upload_failed',

              upload_id:
                uploadId
            },
            extraPayload || {}
          )
        );
      }

      // ----------------------------------------------------------
      // Validate browser state.
      // ----------------------------------------------------------

      if (!file) {
        failUpload(
          'We couldn’t access the selected file.'
        );

        return;
      }

      if (
        !uploadId ||
        !temporaryUploadUrl
      ) {
        failUpload(
          'The secure upload could not be started.'
        );

        return;
      }

      // ----------------------------------------------------------
      // Determine actual browser file type.
      // ----------------------------------------------------------

      var actualFileType =
        normalizeFileType(
          file.name
        );

      if (!actualFileType) {
        failUpload(
          'The selected file type is not supported.'
        );

        return;
      }

      // ----------------------------------------------------------
      // Validate type against backend authorization.
      // ----------------------------------------------------------

      if (
        expectedFileType &&
        actualFileType !== expectedFileType
      ) {
        console.error(
          'ARCOS: File type mismatch.',
          {
            expected:
              expectedFileType,

            actual:
              actualFileType
          }
        );

        failUpload(
          'The selected file no longer matches the upload request.'
        );

        return;
      }

      // ----------------------------------------------------------
      // Optional size consistency check.
      // ----------------------------------------------------------
      //
      // /secure-upload does NOT accept client-supplied size,
      // so file_size may not be present in the API result.
      // When Voiceflow does provide it, validate it.
      // ----------------------------------------------------------

      if (
        Number.isFinite(
          expectedFileSize
        ) &&
        expectedFileSize > 0 &&
        file.size !== expectedFileSize
      ) {
        console.error(
          'ARCOS: File size mismatch.',
          {
            expected:
              expectedFileSize,

            actual:
              file.size
          }
        );

        failUpload(
          'The selected file no longer matches the upload request.'
        );

        return;
      }

      // ----------------------------------------------------------
      // IMPORTANT:
      //
      // Do NOT compare file.name to the backend response
      // file_name.
      //
      // /secure-upload sanitizes the filename before returning
      // it. A literal browser-name comparison could therefore
      // reject an otherwise valid upload.
      // ----------------------------------------------------------

      // ----------------------------------------------------------
      // Canonical content type.
      //
      // We derive it from the authorized extension rather than
      // trusting browser File.type.
      // ----------------------------------------------------------

      var contentType =
        getCanonicalContentType(
          actualFileType
        );

      // ----------------------------------------------------------
      // Direct browser -> signed GCS PUT
      // ----------------------------------------------------------

      fetch(
        temporaryUploadUrl,
        {
          method: 'PUT',

          headers: {
            'Content-Type':
              contentType
          },

          body:
            file
        }
      )
        .then(
          function (response) {
            if (!response.ok) {
              throw new Error(
                'GCS upload failed with HTTP ' +
                  response.status +
                  '.'
              );
            }

            return response;
          }
        )

        .then(
          function () {
            status.textContent =
              'File uploaded securely.';

            if (
              state.selectionToken ===
              selectionTokenAtUploadStart
            ) {
              state.selectedFile = null;
            }

            if (
              state.activeUploadId ===
              uploadId
            ) {
              state.activeUploadId = null;
            }

            sendVoiceflowEvent({
              arcos_event:
                'upload_complete',

              upload_id:
                uploadId
            });
          }
        )

        .catch(
          function (error) {
            console.error(
              'ARCOS upload failed:',
              error
            );

            failUpload(
              'The file could not be uploaded.'
            );
          }
        );
    }
  };

  // ------------------------------------------------------------
  // Load confirmation
  // ------------------------------------------------------------

  console.info(
    'ARCOS File Upload Extensions loaded. Version ' +
      ARCOS_EXTENSION_VERSION
  );
})();
