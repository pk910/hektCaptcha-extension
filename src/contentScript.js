'use strict';

// Content script file will run in the context of web page.
// With content script you can manipulate the web pages using
// Document Object Model (DOM).
// You can also pass information to the parent extension.

// We execute this script by making an entry in manifest.json file
// under `content_scripts` property

// For more information on Content Scripts,
// See https://developer.chrome.com/extensions/content_scripts

import Jimp from 'jimp';
const ort = require('onnxruntime-web');

const extension_id = chrome.runtime.id;

// Modify ort wasm path
ort.env.wasm.wasmPaths = {
  'ort-wasm.wasm': `chrome-extension://${extension_id}/dist/ort-wasm.wasm`,
  'ort-wasm-threaded.wasm': `chrome-extension://${extension_id}/dist/ort-wasm-threaded.wasm`,
  'ort-wasm-simd.wasm': `chrome-extension://${extension_id}/dist/ort-wasm-simd.wasm`,
  'ort-wasm-simd-threaded.wasm': `chrome-extension://${extension_id}/dist/ort-wasm-simd-threaded.wasm`,
};

class Time {
  static sleep(i = 1000) {
    return new Promise((resolve) => setTimeout(resolve, i));
  }

  static async random_sleep(min, max) {
    const duration = Math.floor(Math.random() * (max - min) + min);
    return await Time.sleep(duration);
  }
}

async function letterboxImage(image, size) {
  const iw = image.bitmap.width;
  const ih = image.bitmap.height;
  const [w, h] = size;
  const scale = Math.min(w / iw, h / ih);
  const nw = Math.floor(iw * scale);
  const nh = Math.floor(ih * scale);

  image = await image.resize(nw, nh, Jimp.RESIZE_BICUBIC);
  const newImage = new Jimp(w, h, 0x727272ff);
  newImage.composite(image, (w - nw) / 2, (h - nh) / 2);
  return newImage;
}

function scaleBoxes(boxes, imageDims, scaledDims) {
  const gain = Math.min(
    scaledDims[0] / imageDims[0],
    scaledDims[1] / imageDims[1]
  );
  const wPad = (scaledDims[0] - gain * imageDims[0]) / 2;
  const hPad = (scaledDims[1] - gain * imageDims[1]) / 2;
  return boxes.map((box, i) => (box - (i % 2 === 0 ? wPad : hPad)) / gain);
}

function imageDataToTensor(image, dims, normalize = true) {
  // 1. Get buffer data from image and extract R, G, and B arrays.
  var imageBufferData = image.bitmap.data;
  const [redArray, greenArray, blueArray] = [[], [], []];

  // 2. Loop through the image buffer and extract the R, G, and B channels
  for (let i = 0; i < imageBufferData.length; i += 4) {
    redArray.push(imageBufferData[i]);
    greenArray.push(imageBufferData[i + 1]);
    blueArray.push(imageBufferData[i + 2]);
  }

  // 3. Concatenate RGB to transpose [224, 224, 3] -> [3, 224, 224] to a number array
  const transposedData = redArray.concat(greenArray, blueArray);

  // 4. Convert to float32 and normalize to 1
  const float32Data = new Float32Array(transposedData.map((x) => x / 255.0));

  // 5. Normalize the data mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
  if (normalize) {
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    for (let i = 0; i < float32Data.length; i++) {
      float32Data[i] = (float32Data[i] - mean[i % 3]) / std[i % 3];
    }
  }

  // 6. Create a tensor from the float32 data
  const inputTensor = new ort.Tensor('float32', float32Data, dims);
  return inputTensor;
}

function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((acc, val, i) => acc + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((acc, val) => acc + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((acc, val) => acc + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

function simulateMouseClick(element, clientX = null, clientY = null) {
  if (clientX === null || clientY === null) {
    const box = element.getBoundingClientRect();
    clientX = box.left + box.width / 2;
    clientY = box.top + box.height / 2;
  }

  if (isNaN(clientX) || isNaN(clientY)) {
    return;
  }

  // Send mouseover, mousedown, mouseup, click, mouseout
  const eventNames = [
    'mouseover',
    'mouseenter',
    'mousedown',
    'mouseup',
    'click',
    'mouseout',
  ];
  eventNames.forEach((eventName) => {
    const detail = eventName === 'mouseover' ? 0 : 1;
    const event = new MouseEvent(eventName, {
      detail: detail,
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: clientX,
      clientY: clientY,
      sourceCapabilities: new InputDeviceCapabilities({
        firesTouchEvents: false,
      }),
    });
    element.dispatchEvent(event);
  });
}

(async () => {
  function is_widget_frame() {
    if (
      document.body.getBoundingClientRect()?.width === 0 ||
      document.body.getBoundingClientRect()?.height === 0
    ) {
      return false;
    }
    return document.querySelector('div.check') !== null;
  }

  function is_image_frame() {
    return document.querySelector('h2.prompt-text') !== null;
  }

  function open_image_frame() {
    simulateMouseClick(document.querySelector('#anchor'));
  }

  function is_solved() {
    const is_widget_frame_solved =
      document.querySelector('div.check')?.style['display'] === 'block';
    return is_widget_frame_solved;
  }

  function get_image_url($e) {
    const matches = $e?.style['background']?.trim()?.match(/(?!^)".*?"/g);
    if (!matches || matches.length === 0) {
      return null;
    }
    return matches[0].replaceAll('"', '');
  }

  async function get_task() {
    let task = document
      .querySelector('h2.prompt-text')
      ?.innerText?.replace(/\s+/g, ' ')
      ?.trim();
    if (!task) {
      return null;
    }

    const CODE = {
      '0430': 'a',
      '0441': 'c',
      '0501': 'd',
      '0065': 'e',
      '0435': 'e',
      '04bb': 'h',
      '0069': 'i',
      '0456': 'i',
      '0458': 'j',
      '03f3': 'j',
      '04cf': 'l',
      '03bf': 'o',
      '043e': 'o',
      '0440': 'p',
      '0455': 's',
      '0445': 'x',
      '0443': 'y',
      '0335': '-',
    };

    function pad_left(s, char, n) {
      while (`${s}`.length < n) {
        s = `${char}${s}`;
      }
      return s;
    }

    const new_task = [];
    for (const e of task) {
      const k = pad_left(e.charCodeAt(0).toString(16), '0', 4);
      if (k in CODE) {
        new_task.push(CODE[k]);
      } else {
        new_task.push(e);
      }
    }
    return new_task.join('');
  }

  let lastUrls = null;
  function on_task_ready(i = 500) {
    return new Promise((resolve) => {
      let checking = false;
      const check_interval = setInterval(async () => {
        if (checking) {
          return;
        }
        checking = true;

        let task = await get_task();
        if (!task) {
          checking = false;
          return;
        }

        // Determine hCaptcha type
        let type = null;
        if (document.querySelector('.challenge-view > .task-grid')) {
          type = 'CLASSIFY';
        } else if (document.querySelector('.challenge-view > .task-wrapper')) {
          type = 'MULTI_CHOICE';
        } else if (
          document.querySelector('.challenge-view > .bounding-box-example')
        ) {
          type = 'BOUNDING_BOX';
        }

        const cells = [];
        const urls = [];
        // Get image URLs and cells
        if (type === 'CLASSIFY' || type === 'MULTI_CHOICE') {
          const $cells = document.querySelectorAll(
            '.task-image, .challenge-answer'
          );

          if ($cells.length === 0) {
            checking = false;
            return;
          }

          for (const $e of $cells) {
            const $img = $e.querySelector('div.image');
            if (!$img) {
              checking = false;
              return;
            }

            const url = get_image_url($img);
            if (!url || url === '') {
              checking = false;
              return;
            }

            cells.push($e);
            urls.push(url);
          }
        } else if (type === 'BOUNDING_BOX') {
          const $canvas = document.querySelector('.challenge-view > canvas');
          if (!$canvas) {
            checking = false;
            return;
          }

          cells.push($canvas);
          urls.push($canvas.toDataURL('image/jpeg'));
        }

        const currentUrls = JSON.stringify(urls);
        if (lastUrls === currentUrls && type !== 'BOUNDING_BOX') {
          checking = false;
          return;
        }
        lastUrls = currentUrls;

        clearInterval(check_interval);
        checking = false;
        return resolve({
          task,
          type,
          cells,
          urls,
        });
      }, i);
    });
  }

  function submit() {
    try {
      simulateMouseClick(document.querySelector('.button-submit'));
    } catch (e) {
      console.error('error submitting', e);
    }
  }

  async function refresh() {
    try {
      simulateMouseClick(document.querySelector('.refresh.button'));
      await Time.sleep(250);
    } catch (e) {
      console.error('error refreshing', e);
    }
  }

  function is_cell_selected($cell) {
    return $cell.getAttribute('aria-pressed') === 'true';
  }

  async function on_widget_frame() {
    // Wait if already solved
    if (is_solved()) {
      return;
    }
    await Time.sleep(500);
    open_image_frame();
  }

  async function on_image_frame(settings) {
    if (
      document.querySelector('.display-language .text').textContent !== 'EN'
    ) {
      simulateMouseClick(
        document.querySelector('.language-selector .option:nth-child(23)')
      );
      await Time.sleep(500);
    }

    const refreshButton = document.querySelector('.refresh.button');

    const { task, type, cells, urls } = await on_task_ready();

    const featSession = await ort.InferenceSession.create(
      `chrome-extension://${extension_id}/models/mobilenetv3.ort`
    );

    // Usual 3x3 grid, classify
    if (type == 'CLASSIFY') {
      // Get label for image
      const label = task
        .replace('Please click each image containing', '')
        .replace('Please click on all images containing', '')
        .replace('Please click on all images of', '')
        .replace('Select all images containing', '')
        .trim()
        .replace(/^(a|an)\s+/i, '')
        .replace(/\s+/g, '_')
        .toLowerCase();

      const fetchModel = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CLASSIFIER', label }, resolve);
      });

      if (fetchModel.status !== 200) {
        console.log('error getting model', fetchModel, label);
        if (refreshButton.isConnected) await refresh();
        return;
      }
      const model = await fetch(fetchModel.base64);
      const modelBuffer = await model.arrayBuffer();
      const classifierSession = await ort.InferenceSession.create(modelBuffer);

      // Solve task
      for (let i = 0; i < urls.length; i++) {
        if (!cells[i].isConnected) {
          return;
        }
        // Read image from URL
        const image = await Jimp.read(urls[i]);

        // Resize image to 224x224 with bilinear interpolation
        image.resize(224, 224, Jimp.RESIZE_BILINEAR);

        // Convert image data to tensor
        const input = imageDataToTensor(image, [1, 3, 224, 224]);

        // Feed input tensor to feature extractor model and run it
        const featOutputs = await featSession.run({ input: input });
        const feats = featOutputs[featSession.outputNames[0]];

        // Feed feats to classifier
        const classifierOutputs = await classifierSession.run({ input: feats });
        const output = classifierOutputs[classifierSession.outputNames[0]].data;

        // Find index of maximum value in output array
        const argmaxValue = output.indexOf(Math.max(...output));

        // If argmaxValue is 1, click on cell (if it is not already selected)
        if (argmaxValue === 1 && !is_cell_selected(cells[i])) {
          await Time.sleep(settings.click_delay_time);
          simulateMouseClick(cells[i]);
        }
      }

      if (cells[0].isConnected) {
        await Time.sleep(settings.solve_delay_time);
        return submit();
      }
    }
    // 1x3 grid, multi choice (similar image)
    else if (type == 'MULTI_CHOICE') {
      const embeddings = await Promise.all(
        urls.map(async (url) => {
          // Read image from URL
          const image = await Jimp.read(url);

          // Resize image to 224x224 with bilinear interpolation
          image.resize(224, 224, Jimp.RESIZE_BILINEAR);

          // Convert image data to tensor
          const input = imageDataToTensor(image, [1, 3, 224, 224]);

          // Feed input tensor to feature extractor model and run it
          const featOutputs = await featSession.run({ input: input });
          const feats = featOutputs[featSession.outputNames[0]];

          return feats.data;
        })
      );

      // Get first embeddings (task-image)
      const taskEmbedding = embeddings[0];
      embeddings.shift();
      cells.shift();

      // Get highest cosine similarity with taskEmbedding in one shot
      // Thanks Copilot.
      const highestSimIdx = embeddings
        .map((embedding) => cosineSimilarity(taskEmbedding, embedding))
        .reduce((iMax, x, i, arr) => (x > arr[iMax] ? i : iMax), 0);

      if (
        cells[highestSimIdx].isConnected &&
        !is_cell_selected(cells[highestSimIdx])
      ) {
        // Click on cell with highest similarity
        await Time.sleep(settings.click_delay_time);
        simulateMouseClick(cells[highestSimIdx]);

        // Submit
        await Time.sleep(settings.click_delay_time * 2.5);
        return submit();
      }
    } else if (type == 'BOUNDING_BOX') {
      const fetchModel = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CLASSIFIER', label: 'detector' },
          resolve
        );
      });

      if (fetchModel.status !== 200) {
        console.log('error getting detector model', fetchModel);
        if (refreshButton.isConnected) await refresh();
        return;
      }
      const model = await fetch(fetchModel.base64);
      const modelBuffer = await model.arrayBuffer();
      const session = await ort.InferenceSession.create(modelBuffer);

      const nmsSession = await ort.InferenceSession.create(
        `chrome-extension://${extension_id}/models/nms.ort`
      );

      const cellWidth = cells[0].getBoundingClientRect().width;
      const cellHeight = cells[0].getBoundingClientRect().height;

      // Get url and remove data:image/png;base64,
      const url = urls[0].split(',')[1];
      // If url size is smaller than 50kb then return empty
      if (url.length < 50 * 1024) {
        return;
      }
      const image = await Jimp.read(Buffer.from(url, 'base64'));
      image.rgba(false);

      // [topK, ioUThreshold, scoreThreshold]
      const config = new ort.Tensor(
        'float32',
        new Float32Array([1, 0.45, 0.1])
      );
      const inputImage = await letterboxImage(image, [640, 640]);
      const inputTensor = imageDataToTensor(
        inputImage,
        [1, 3, 640, 640],
        false
      );

      // YOLOv5 detector
      const outputMap = await session.run({ images: inputTensor });
      const output0 = outputMap[session.outputNames[0]];

      // NMS (Non-Maximum Suppression)
      const nmsOutput = await nmsSession.run({
        detection: outputMap[session.outputNames[0]],
        config: config,
      });
      const selectedIdx = nmsOutput[nmsSession.outputNames[0]];
      if (selectedIdx.data.length === 0) {
        return refresh();
      }

      for (let i = 0; i < selectedIdx.data.length; i++) {
        const idx = selectedIdx.data[i];
        const data = output0.data.slice(
          idx * output0.dims[2],
          (idx + 1) * output0.dims[2]
        );
        const [x, y, w, h] = data.slice(0, 4);

        const [x1, y1, w1, h1] = scaleBoxes(
          [x, y, w, h],
          [cellWidth, cellHeight],
          [640, 640]
        );
        const [x2, y2, x3, y3] = [
          x1 - w1 / 2,
          y1 - h1 / 2,
          x1 + w1 / 2,
          y1 + h1 / 2,
        ];

        // Get middle coordinate of result
        const middleX = (x2 + x3) / 2;
        const middleY = (y2 + y3) / 2;

        simulateMouseClick(cells[0], middleX, middleY);
        await Time.sleep(settings.solve_delay_time);
        return submit();
      }
    } else {
      if (refreshButton.isConnected) await refresh();
    }
  }

  while (true) {
    await Time.sleep(1000);
    if (!chrome.runtime?.id) {
      continue;
    }

    let settings = await chrome.storage.local.get(null);
    if (is_widget_frame() && settings.auto_open) {
      await on_widget_frame();
    } else if (is_image_frame() && settings.auto_solve) {
      await on_image_frame(settings);
    }
  }
})();
