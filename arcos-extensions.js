(function () {
  'use strict';

  // ============================================================
  // ARCOS FILE UPLOAD EXTENSION
  // ============================================================
  //
  // Two Voiceflow custom-response extensions:
  //
  // 1. ARCOS_FILE_SELECTION
  //    - Lets the user choose a file.
  //    - Stores the browser File object locally.
  //    - Sends file metadata back to Voiceflow.
  //
  // 2. ARCOS_FILE_UPLOAD
  //    - Receives the temporary GCS signed PUT URL.
  //    - Uploads the selected File directly to GCS.
  //    - Signals success/failure back to Voiceflow.
  //
  // No ARCOS secrets or API keys belong in this code.
  // ============================================================


  // ------------------------------------------------------------
  // Local browser state
  // ------------------------------------------------------------

  window.__ARCOS_SELECTED_FILE = null;


  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  function getExtension(fileName) {
    const parts = String(fileName || '').toLowerCase().split('.');

    if (parts.length < 2) {
      return '';
    }

    return parts.pop();
  }


  function normalizeFileType(fileName) {
    const extension = getExtension(fileName);

    const types = {
      jpg: 'JPG',
      jpeg: 'JPEG',
      heic: 'HEIC',
      pdf: 'PDF',
      mp4: 'MP4',
      mov: 'MOV'
    };

    return types[extension] || '';
  }


  function getContentType(file, normalizedType) {
    if (file && file.type) {
      return file.type;
    }

    const fallbackTypes = {
      JPG: 'image/jpeg',
      JPEG: 'image/jpeg',
      HEIC: 'image/heic',
      PDF: 'application/pdf',
      MP4: 'video/mp4',
      MOV: 'video/quicktime'
    };

    return fallbackTypes[normalizedType] || 'application/octet-stream';
  }


  function formatFileSize(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }


  function sendVoiceflowEvent(type, payload) {
    if (
      !window.voiceflow ||
      !window.voiceflow.chat ||
      typeof window.voiceflow.chat.interact !== 'function'
    ) {
      console.error('ARCOS: Voiceflow chat API is unavailable.');
      return;
    }

    window.voiceflow.chat.interact({
      type: type,
      payload: payload || {}
    });
  }


  function setStatus(element, message) {
    if (element) {
      element.textContent = message;
    }
  }


  function buildError(message) {
    const error = document.createElement('div');

    error.style.marginTop = '10px';
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


  // ============================================================
  // ARCOS FILE SELECTION EXTENSION
  // ============================================================

  window.ARCOSFileSelectionExtension = {

    name: 'ARCOSFileSelection',

    type: 'response',

    match: function ({ trace }) {
      return (
        trace.type === 'ext_arcos_file_selection' ||
        trace.payload?.name === 'ext_arcos_file_selection'
      );
    },

    render: function ({ trace, element }) {

      const payload = trace.payload || {};

      const fileCategory = String(
        payload.file_category ||
        payload.fileCategory ||
        ''
      ).trim().toLowerCase();

      const isEvidence = fileCategory === 'evidence';

      const container = document.createElement('div');

      container.style.width = '100%';
      container.style.boxSizing = 'border-box';


      // ----------------------------------------------------------
      // HTML
      // ----------------------------------------------------------

      container.innerHTML = `
        <div
          class="arcos-upload-card"
          style="
            display:flex;
            flex-direction:column;
            gap:10px;
            padding:14px;
            border:1px solid rgba(0,0,0,0.12);
            border-radius:10px;
            background:#ffffff;
            box-sizing:border-box;
          "
        >

          <div
            style="
              font-size:14px;
              font-weight:600;
            "
          >
            ${
              isEvidence
                ? 'How would you like to upload your evidence?'
                : 'Choose your medical document'
            }
          </div>


          <button
            type="button"
            class="arcos-photo-document-button"
            style="
              width:100%;
              padding:11px 14px;
              border:1px solid rgba(0,0,0,0.15);
              border-radius:8px;
              background:#ffffff;
              cursor:pointer;
              font-size:14px;
            "
          >
            ${isEvidence ? 'Choose a photo or document' : 'Choose a photo or document'}
          </button>


          ${
            isEvidence
              ? `
                <button
                  type="button"
                  class="arcos-video-button"
                  style="
                    width:100%;
                    padding:11px 14px;
                    border:1px solid rgba(0,0,0,0.15);
                    border-radius:8px;
                    background:#ffffff;
                    cursor:pointer;
                    font-size:14px;
                  "
                >
                  Choose a video
                </button>
              `
              : ''
          }


          <button
            type="button"
            class="arcos-cancel-button"
            style="
              width:100%;
              padding:8px 12px;
              border:none;
              background:transparent;
              cursor:pointer;
              font-size:13px;
              opacity:0.75;
            "
          >
            Cancel
          </button>


          <div
            class="arcos-status"
            style="
              font-size:12px;
              line-height:1.4;
              opacity:0.75;
            "
          ></div>

        </div>
      `;


      // ----------------------------------------------------------
      // Elements
      // ----------------------------------------------------------

      const photoDocumentButton =
        container.querySelector('.arcos-photo-document-button');

      const videoButton =
        container.querySelector('.arcos-video-button');

      const cancelButton =
        container.querySelector('.arcos-cancel-button');

      const statusElement =
        container.querySelector('.arcos-status');


      // ----------------------------------------------------------
      // Hidden file inputs
      // ----------------------------------------------------------

      const photoDocumentInput = document.createElement('input');

      photoDocumentInput.type = 'file';

      photoDocumentInput.accept =
        '.jpg,.jpeg,.heic,.pdf,image/jpeg,image/heic,application/pdf';

      photoDocumentInput.style.display = 'none';


      const videoInput = document.createElement('input');

      videoInput.type = 'file';

      videoInput.accept =
        '.mp4,.mov,video/mp4,video/quicktime';

      videoInput.style.display = 'none';


      container.appendChild(photoDocumentInput);

      if (isEvidence && videoButton) {
        container.appendChild(videoInput);
      }


      // ----------------------------------------------------------
      // Disable selector UI
      // ----------------------------------------------------------

      function disableControls() {

        photoDocumentButton.disabled = true;

        if (videoButton) {
          videoButton.disabled = true;
        }

        cancelButton.disabled = true;

        photoDocumentButton.style.opacity = '0.55';

        if (videoButton) {
          videoButton.style.opacity = '0.55';
        }

        cancelButton.style.opacity = '0.55';
      }


      // ----------------------------------------------------------
      // Re-enable selector UI after validation failure
      // ----------------------------------------------------------

      function enableControls() {

        photoDocumentButton.disabled = false;

        if (videoButton) {
          videoButton.disabled = false;
        }

        cancelButton.disabled = false;

        photoDocumentButton.style.opacity = '1';

        if (videoButton) {
          videoButton.style.opacity = '1';
        }

        cancelButton.style.opacity = '0.75';
      }


      // ----------------------------------------------------------
      // Client-side validation
      //
      // This is UX validation only.
      // The backend remains authoritative.
      // ----------------------------------------------------------

      async function validateSelectedFile(file) {

        if (!file) {
          return {
            valid: false,
            message: 'No file was selected.'
          };
        }


        const normalizedType =
          normalizeFileType(file.name);


        if (!normalizedType) {
          return {
            valid: false,
            message: 'That file type is not supported.'
          };
        }


        const documentTypes = [
          'JPG',
          'JPEG',
          'HEIC',
          'PDF'
        ];


        const videoTypes = [
          'MP4',
          'MOV'
        ];


        // --------------------------------------------------------
        // Medical Documentation
        // --------------------------------------------------------

        if (!isEvidence) {

          if (!documentTypes.includes(normalizedType)) {
            return {
              valid: false,
              message:
                'Please choose a JPG, JPEG, HEIC, or PDF file.'
            };
          }


          if (file.size > 50 * 1024 * 1024) {
            return {
              valid: false,
              message:
                'That file is larger than the 50 MB limit.'
            };
          }


          return {
            valid: true,
            normalizedType: normalizedType
          };
        }


        // --------------------------------------------------------
        // Evidence: photo/document
        // --------------------------------------------------------

        if (documentTypes.includes(normalizedType)) {

          if (file.size > 50 * 1024 * 1024) {
            return {
              valid: false,
              message:
                'That file is larger than the 50 MB limit.'
            };
          }


          return {
            valid: true,
            normalizedType: normalizedType
          };
        }


        // --------------------------------------------------------
        // Evidence: video
        // --------------------------------------------------------

        if (videoTypes.includes(normalizedType)) {

          if (file.size > 512 * 1024 * 1024) {
            return {
              valid: false,
              message:
                'That video is larger than the 512 MB limit.'
            };
          }


          const duration = await new Promise(function (resolve) {

            const video = document.createElement('video');

            video.preload = 'metadata';

            video.onloadedmetadata = function () {
              const durationValue = video.duration;

              URL.revokeObjectURL(video.src);

              resolve(durationValue);
            };


            video.onerror = function () {
              URL.revokeObjectURL(video.src);

              resolve(null);
            };


            video.src = URL.createObjectURL(file);
          });


          if (duration === null || !Number.isFinite(duration)) {
            return {
              valid: false,
              message:
                'That video could not be read. Please choose another MP4 or MOV file.'
            };
          }


          if (duration > 180) {
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


      // ----------------------------------------------------------
      // File selection
      // ----------------------------------------------------------

      async function handleFileSelection(file) {

        if (!file) {
          return;
        }


        setStatus(
          statusElement,
          'Checking the selected file...'
        );


        const validation =
          await validateSelectedFile(file);


        if (!validation.valid) {

          window.__ARCOS_SELECTED_FILE = null;

          container.appendChild(
            buildError(validation.message)
          );

          enableControls();

          setStatus(
            statusElement,
            'Please choose another file.'
          );

          return;
        }


        // Store the actual browser File object.
        window.__ARCOS_SELECTED_FILE = file;


        const normalizedType =
          validation.normalizedType;


        disableControls();


        setStatus(
          statusElement,
          `${file.name} selected (${formatFileSize(file.size)}).`
        );


        // --------------------------------------------------------
        // Send metadata back to Voiceflow.
        //
        // The ARCOS Capture File Metadata Function reads these
        // values from last_event.payload.
        // --------------------------------------------------------

        sendVoiceflowEvent(
          'file_selected',
          {
            file_name: file.name,
            file_type: normalizedType,
            file_size: file.size
          }
        );
      }


      // ----------------------------------------------------------
      // Button handlers
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

          const file =
            photoDocumentInput.files &&
            photoDocumentInput.files[0];

          handleFileSelection(file);
        }
      );


      if (videoButton) {

        videoButton.addEventListener(
          'click',
          function () {

            videoInput.value = '';

            videoInput.click();
          }
        );
      }


      if (videoButton) {

        videoInput.addEventListener(
          'change',
          function () {

            const file =
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

          window.__ARCOS_SELECTED_FILE = null;

          disableControls();

          setStatus(
            statusElement,
            'Upload cancelled.'
          );


          sendVoiceflowEvent(
            'cancelled',
            {}
          );
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

    match: function ({ trace }) {
      return (
        trace.type === 'ext_arcos_file_upload' ||
        trace.payload?.name === 'ext_arcos_file_upload'
      );
    },

    render: function ({ trace, element }) {

      const payload = trace.payload || {};

      const uploadId =
        String(
          payload.upload_id || ''
        ).trim();


      const temporaryUploadUrl =
        String(
          payload.temporary_upload_url || ''
        ).trim();


      const expectedFileName =
        String(
          payload.file_name || ''
        ).trim();


      const expectedFileType =
        String(
          payload.file_type || ''
        ).trim()
        .toUpperCase();


      const expectedFileSize =
        Number(payload.file_size);


      const container = document.createElement('div');

      container.style.padding = '12px 0';


      const status = document.createElement('div');

      status.textContent =
        'Uploading your file securely...';

      status.style.fontSize = '13px';

      status.style.lineHeight = '1.5';


      container.appendChild(status);

      element.appendChild(container);


      // ----------------------------------------------------------
      // Validate the browser-side state before uploading.
      // ----------------------------------------------------------

      const file =
        window.__ARCOS_SELECTED_FILE;


      if (!file) {

        status.textContent =
          'We couldn’t access the selected file.';

        sendVoiceflowEvent(
          'upload_failed',
          {
            upload_id: uploadId
          }
        );

        return;
      }


      if (!uploadId || !temporaryUploadUrl) {

        status.textContent =
          'The secure upload could not be started.';

        sendVoiceflowEvent(
          'upload_failed',
          {
            upload_id: uploadId
          }
        );

        return;
      }


      const actualFileType =
        normalizeFileType(file.name);


      if (
        expectedFileName &&
        file.name !== expectedFileName
      ) {

        console.error(
          'ARCOS: File name mismatch.'
        );

        status.textContent =
          'The selected file no longer matches the upload request.';

        sendVoiceflowEvent(
          'upload_failed',
          {
            upload_id: uploadId
          }
        );

        return;
      }


      if (
        expectedFileType &&
        actualFileType !== expectedFileType
      ) {

        console.error(
          'ARCOS: File type mismatch.'
        );

        status.textContent =
          'The selected file no longer matches the upload request.';

        sendVoiceflowEvent(
          'upload_failed',
          {
            upload_id: uploadId
          }
        );

        return;
      }


      if (
        Number.isFinite(expectedFileSize) &&
        file.size !== expectedFileSize
      ) {

        console.error(
          'ARCOS: File size mismatch.'
        );

        status.textContent =
          'The selected file no longer matches the upload request.';

        sendVoiceflowEvent(
          'upload_failed',
          {
            upload_id: uploadId
          }
        );

        return;
      }


      // ----------------------------------------------------------
      // Perform direct PUT to the temporary GCS signed URL.
      // ----------------------------------------------------------

      const contentType =
        getContentType(
          file,
          actualFileType
        );


      fetch(
        temporaryUploadUrl,
        {
          method: 'PUT',

          headers: {
            'Content-Type': contentType
          },

          body: file
        }
      )
        .then(function (response) {

          if (!response.ok) {

            throw new Error(
              `GCS upload failed with HTTP ${response.status}.`
            );
          }

          return response;
        })

        .then(function () {

          status.textContent =
            'File uploaded securely.';

          // Clear the local browser File reference.
          window.__ARCOS_SELECTED_FILE = null;


          // Tell the Voiceflow Execute File Upload
          // Function that the PUT succeeded.
          sendVoiceflowEvent(
            'upload_complete',
            {
              upload_id: uploadId
            }
          );
        })

        .catch(function (error) {

          console.error(
            'ARCOS upload failed:',
            error
          );


          window.__ARCOS_SELECTED_FILE = null;


          status.textContent =
            'The file could not be uploaded.';


          sendVoiceflowEvent(
            'upload_failed',
            {
              upload_id: uploadId
            }
          );
        });
    }
  };

})();
