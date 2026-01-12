// CopyPasteManager.js
// コピー&ペースト機能を管理するクラス

//---------------------------------------------------------------------------
// ★CopyPasteManagerクラス 矩形範囲のコピー&ペーストを管理する
//---------------------------------------------------------------------------
pzpr.classmgr.makeCommon({
	//---------------------------------------------------------
	CopyPasteManager: {
		initialize: function() {
			this.mode = null; // null, 'selecting', 'pasting'
			this.startCell = null; // { bx, by }
			this.endCell = null; // { bx, by }
			this.copiedData = null; // 2次元配列 [[qnum, ...], ...]
			this.copiedWidth = 0; // コピーした範囲の幅（セル数）
			this.copiedHeight = 0; // コピーした範囲の高さ（セル数）
			this.pastePreviewPos = null; // { bx, by } ペーストプレビューの位置
			this.overlayCanvas = null;
			this.initialized = false;
			this.rotateStep = 0; // 0,1,2,3 => 0/90/180/270
			this.flipH = false; // trueなら左右反転
		},

		//---------------------------------------------------------------------------
		// manager.setupCanvas() Canvas準備完了後の初期化（Puzzleから呼ばれる）
		//---------------------------------------------------------------------------
		setupCanvas: function() {
			if (this.initialized) {
				return;
			}
			this.createOverlayCanvas();
			this.hookMouseEvents();
			this.attachButtonEvents();
			this.attachResizeListener();
			this.initialized = true;
		},

		//---------------------------------------------------------------------------
		// overlayCanvas.createOverlayCanvas() オーバーレイキャンバスを作成する
		//---------------------------------------------------------------------------
		createOverlayCanvas: function() {
			// pzprv3はSVGを使用するので、SVG要素を基準にする
			var svg = this.puzzle.painter.context.canvas;
			var parent = svg.parentNode;

			// SVGのサイズと位置を取得
			var svgRect = svg.getBoundingClientRect();
			var parentRect = parent.getBoundingClientRect();

			var overlay = document.createElement('canvas');
			// Set canvas size to match SVG layout size (CSS pixels) and account for devicePixelRatio
			var dpr = window.devicePixelRatio || 1;
			var cssW = svgRect.width;
			var cssH = svgRect.height;
			overlay.width = Math.max(1, Math.round(cssW * dpr));
			overlay.height = Math.max(1, Math.round(cssH * dpr));
			overlay.style.width = cssW + 'px';
			overlay.style.height = cssH + 'px';
			overlay.style.position = 'absolute';
			// SVGの位置に合わせる（親要素からの相対位置）
			overlay.style.left = (svgRect.left - parentRect.left) + 'px';
			overlay.style.top = (svgRect.top - parentRect.top) + 'px';
			overlay.style.pointerEvents = 'none';
			overlay.style.display = 'none';
			overlay.style.zIndex = '1000';
			// store dpr for drawing routines
			overlay._dpr = dpr;
			// ensure crisp drawing on high-DPI displays
			var ctx = overlay.getContext('2d');
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			parent.appendChild(overlay);
			this.overlayCanvas = overlay;

			// console.log('Overlay canvas created:', overlay.width, 'x', overlay.height, 'at', overlay.style.left, overlay.style.top);
		},

		//---------------------------------------------------------------------------
		// manager._updateOverlaySizePos() overlayのサイズ・位置を最新化する
		//---------------------------------------------------------------------------
		_updateOverlaySizePos: function() {
			if (!this.overlayCanvas) {
				return;
			}

			var overlay = this.overlayCanvas;
			var svg = this.puzzle.painter.context.canvas;
			var parent = svg.parentNode;
			var svgRect = svg.getBoundingClientRect();
			var parentRect = parent.getBoundingClientRect();
			var dpr = window.devicePixelRatio || 1;
			var cssW = svgRect.width || parseInt(svg.getAttribute('width')) || parent.clientWidth;
			var cssH = svgRect.height || parseInt(svg.getAttribute('height')) || parent.clientHeight;

			// update style position
			overlay.style.left = (svgRect.left - parentRect.left) + 'px';
			overlay.style.top = (svgRect.top - parentRect.top) + 'px';
			overlay.style.width = cssW + 'px';
			overlay.style.height = cssH + 'px';

			// update backing store size if changed
			var intW = Math.max(1, Math.round(cssW * dpr));
			var intH = Math.max(1, Math.round(cssH * dpr));
			if (overlay.width !== intW || overlay.height !== intH || overlay._dpr !== dpr) {
				overlay.width = intW;
				overlay.height = intH;
				overlay._dpr = dpr;
				var ctx = overlay.getContext('2d');
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			}
		},

		//---------------------------------------------------------------------------
		// manager.hookMouseEvents() pzprのマウスイベントをフックする
		//---------------------------------------------------------------------------
		hookMouseEvents: function() {
			var manager = this;
			var puzzle = this.puzzle;
			var mouse = puzzle.mouse;

			// 元のe_mousedownメソッドを保存
			var originalMouseDown = mouse.e_mousedown.bind(mouse);

			// e_mousedownをオーバーライド
			mouse.e_mousedown = function(e) {
				// console.log('Hooked mousedown, mode:', manager.mode);

				// コピーモード中は我々の処理を優先
				if (manager.mode === 'selecting') {
					// console.log('Copy mode active, intercepting click');
					e.preventDefault();
					e.stopPropagation();
					manager.handleCellClick(e);
					return false;
				}

				// ペーストモード中もクリックで確定
				if (manager.mode === 'pasting') {
					// console.log('Paste mode active, confirming paste');
					e.preventDefault();
					e.stopPropagation();
					manager.executePaste();
					return false;
				}

				// 通常モード：コピー範囲が表示されていたら消す
				if (manager.mode === null && (manager.startCell || manager.endCell)) {
					manager.hideSelectionOverlay();
					manager.startCell = null;
					manager.endCell = null;
				}

				// それ以外は元の処理を実行
				return originalMouseDown(e);
			};

			// SVG要素に直接mousemoveイベントを追加（ペーストプレビュー用）
			var svg = puzzle.painter.context.canvas;
			svg.addEventListener('mousemove', function(e) {
				if (manager.mode === 'pasting') {
					manager.updatePastePreview(e);
				}
			}, false);

			// console.log('Mouse events hooked successfully');
		},

		//---------------------------------------------------------------------------
		// manager.attachButtonEvents() UIボタンのクリックイベントをアタッチする
		//---------------------------------------------------------------------------
		attachButtonEvents: function() {
			var manager = this;

			// コピーボタン
			var btnCopy = document.getElementById('btn_copy');
			if (btnCopy) {
				btnCopy.addEventListener('click', function(e) {
					e.preventDefault();
					e.stopPropagation();
					manager.startCopyMode();
				});
			}

			// ペーストボタン
			var btnPaste = document.getElementById('btn_paste');
			if (btnPaste) {
				btnPaste.addEventListener('click', function(e) {
					e.preventDefault();
					e.stopPropagation();
					manager.startPasteMode();
				});
			}

			// 回転(90度)ボタン
			var btnRotate = document.getElementById('btn_rotate90');
			if (btnRotate) {
				btnRotate.addEventListener('click', function(e) {
					e.preventDefault();
					e.stopPropagation();
					manager.rotate90Toggle();
				});
			}

			// 左右反転ボタン
			var btnFlip = document.getElementById('btn_fliph');
			if (btnFlip) {
				btnFlip.addEventListener('click', function(e) {
					e.preventDefault();
					e.stopPropagation();
					manager.flipHToggle();
				});
			}

			// console.log('Button events attached');
		},

		//---------------------------------------------------------------------------
		// manager.attachResizeListener() リサイズイベントリスナーをアタッチする
		//---------------------------------------------------------------------------
		attachResizeListener: function() {
			var manager = this;
			this.puzzle.on('resize', function() {
				// 常にcanvasサイズ・位置を最新化（リサイズ時の選択範囲描画問題を解決）
				manager._updateOverlaySizePos();

				// 選択範囲が表示されている場合は再描画
				if (manager.overlayCanvas && manager.overlayCanvas.style.display !== 'none') {
					if (manager.mode === 'pasting') {
						manager.drawPastePreview();
					} else if (manager.startCell) {
						manager.drawSelectionOverlay();
					}
				}
			});
		},

		//---------------------------------------------------------------------------
		// manager.handleCellClick() セル選択時のクリック処理
		//---------------------------------------------------------------------------
		handleCellClick: function(e) {
			var puzzle = this.puzzle;
			var mouse = puzzle.mouse;

			// マウス座標からボード座標を取得
			var addr = mouse.getBoardAddress(e);

			// inputPointを一時的に設定してgetpos()を使用
			var savedPoint = mouse.inputPoint.clone();
			mouse.inputPoint.init(addr.bx, addr.by);

			// pzprの標準メソッドでセル座標を取得
			var pos = mouse.getpos(0);
			var cell = pos.getc();

			// inputPointを復元
			mouse.inputPoint = savedPoint;

			// ボード範囲外チェック
			if (!cell || cell.isnull) {
				// console.log('Clicked outside valid cell area:', pos.bx, pos.by);
				return;
			}

			if (!this.startCell) {
				// 最初のセルを選択
				this.startCell = { bx: pos.bx, by: pos.by };
				// console.log('First cell selected:', pos.bx, pos.by);
				this.drawSelectionOverlay();
			} else {
				// 2番目のセルを選択してコピー実行
				this.endCell = { bx: pos.bx, by: pos.by };
				// console.log('Second cell selected:', pos.bx, pos.by);
				this.drawSelectionOverlay();  // 範囲を表示
				this.executeCopy();
				// コピー完了後、範囲は表示したままにする（次の操作で自動的に消える）
				this.mode = null;
				this.updateButtonState();
			}
		},

		//---------------------------------------------------------------------------
		// manager.startCopyMode() コピーモードを開始する
		//---------------------------------------------------------------------------
		startCopyMode: function() {
			if (!this.initialized) {
				return;
			}
			this.mode = 'selecting';
			this.startCell = null;
			this.endCell = null;
			this.hideSelectionOverlay();  // 前回のコピー範囲を消す
			this.updateButtonState();
		},

		//---------------------------------------------------------------------------
		// manager.cancelCopyMode() コピーモードをキャンセルする
		//---------------------------------------------------------------------------
		cancelCopyMode: function() {
			this.mode = null;
			this.startCell = null;
			this.endCell = null;
			this.hideSelectionOverlay();
			this.updateButtonState();
		},

		//---------------------------------------------------------------------------
		// manager.executeCopy() 範囲内のデータをコピーする
		//---------------------------------------------------------------------------
		executeCopy: function() {
			if (!this.startCell || !this.endCell) {
				return;
			}

			var bx1 = Math.min(this.startCell.bx, this.endCell.bx);
			var bx2 = Math.max(this.startCell.bx, this.endCell.bx);
			var by1 = Math.min(this.startCell.by, this.endCell.by);
			var by2 = Math.max(this.startCell.by, this.endCell.by);

			var board = this.puzzle.board;
			var data = [];

			for (var by = by1; by <= by2; by += 2) {
				var row = [];
				for (var bx = bx1; bx <= bx2; bx += 2) {
					var cell = board.getc(bx, by);
					row.push(cell ? cell.qnum : -1);
				}
				data.push(row);
			}

			this.copiedData = data;
			this.copiedHeight = data.length;
			this.copiedWidth = data[0].length;
			this.rotateStep = 0;
			this.flipH = false;
			this.mode = null;
			// console.log('Copied ' + data.length + 'x' + data[0].length + ' cells');
		},

		//---------------------------------------------------------------------------
		// manager.startPasteMode() ペーストモードを開始する
		//---------------------------------------------------------------------------
		startPasteMode: function() {
			if (!this.initialized) {
				// console.log('CopyPasteManager not yet initialized');
				return;
			}
			if (!this.copiedData || this.copiedData.length === 0) {
				// console.log('No data to paste');
				return;
			}

			this.mode = 'pasting';
			this.pastePreviewPos = null;
			this.startCell = null;  // コピー範囲をクリア
			this.endCell = null;
			this.hideSelectionOverlay();  // コピー範囲の表示を消す
			this.updateButtonState();
			// console.log('Paste mode: Move mouse to preview, click to confirm');
		},

		//---------------------------------------------------------------------------
		// manager.updatePastePreview() マウス位置でペーストプレビューを更新する
		//---------------------------------------------------------------------------
		updatePastePreview: function(e) {
			var puzzle = this.puzzle;
			var mouse = puzzle.mouse;

			var addr = mouse.getBoardAddress(e);
			var savedPoint = mouse.inputPoint.clone();
			mouse.inputPoint.init(addr.bx, addr.by);
			var pos = mouse.getpos(0);
			mouse.inputPoint = savedPoint;

			var cell = pos.getc();
			if (!cell || cell.isnull) {
				// console.log('Paste preview: invalid cell', pos.bx, pos.by);
				return;
			}

			this.pastePreviewPos = { bx: pos.bx, by: pos.by };
			// console.log('Paste preview updated:', pos.bx, pos.by, 'size:', this.copiedWidth, 'x', this.copiedHeight);
			this.drawPastePreview();
		},

		//---------------------------------------------------------------------------
		// manager.executePaste() ペーストを実行する
		//---------------------------------------------------------------------------
		executePaste: function() {
			if (!this.pastePreviewPos) {
				// console.log('No paste location selected');
				return;
			}

			var puzzle = this.puzzle;
			var bx = this.pastePreviewPos.bx;
			var by = this.pastePreviewPos.by;
			var board = puzzle.board;
			var data = this.getTransformedData();
			if (!data || data.length === 0) {
				return;
			}

			puzzle.opemgr.newOperation();

			for (var dy = 0; dy < data.length; dy++) {
				var row = data[dy];
				for (var dx = 0; dx < row.length; dx++) {
					var targetBx = bx + dx * 2;
					var targetBy = by + dy * 2;
					var cell = board.getc(targetBx, targetBy);

					// 白マス（-1）も含めてすべて上書き
					if (cell && !cell.isnull) {
						cell.setQnum(row[dx]);
					}
				}
			}

			puzzle.redraw();
			this.mode = null;
			this.pastePreviewPos = null;
			this.hideSelectionOverlay();
			this.updateButtonState();
			// console.log('Pasted data at (' + bx + ',' + by + ')');
		},

		//---------------------------------------------------------------------------
		// manager.drawSelectionOverlay() 選択範囲を描画する
		//---------------------------------------------------------------------------
		drawSelectionOverlay: function() {
			if (!this.startCell) {
				return;
			}

			var overlay = this.overlayCanvas;
			if (!overlay) {
				return;
			}
			// Ensure overlay matches SVG size/position
			this._updateOverlaySizePos();
			overlay.style.display = 'block';

			var ctx = overlay.getContext('2d');
			var dpr = overlay._dpr || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr);

			var painter = this.puzzle.painter;
			var bw = painter.bw;
			var bh = painter.bh;
			var x0 = painter.x0;
			var y0 = painter.y0;

			if (this.endCell) {
				// 範囲を描画（セル中心座標から罫線交点座標に変換）
				var bx1 = Math.min(this.startCell.bx, this.endCell.bx);
				var bx2 = Math.max(this.startCell.bx, this.endCell.bx);
				var by1 = Math.min(this.startCell.by, this.endCell.by);
				var by2 = Math.max(this.startCell.by, this.endCell.by);

				// セル中心(奇数)から左上の罫線交点(偶数)と右下の罫線交点(偶数)を計算
				var cornerBx1 = bx1 - 1;  // 左上角
				var cornerBy1 = by1 - 1;
				var cornerBx2 = bx2 + 1;  // 右下角
				var cornerBy2 = by2 + 1;

				// ボード座標からピクセル座標に変換
				var px1 = x0 + cornerBx1 * bw;
				var py1 = y0 + cornerBy1 * bh;
				var px2 = x0 + cornerBx2 * bw;
				var py2 = y0 + cornerBy2 * bh;

				ctx.fillStyle = 'rgba(0, 120, 215, 0.2)';
				ctx.fillRect(px1, py1, px2 - px1, py2 - py1);

				ctx.strokeStyle = 'rgba(0, 120, 215, 0.8)';
				ctx.lineWidth = 2;
				ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);
			} else {
				// 開始セルのみ描画（セル中心座標から罫線交点座標に変換）
				var cornerBx1 = this.startCell.bx - 1;
				var cornerBy1 = this.startCell.by - 1;
				var cornerBx2 = this.startCell.bx + 1;
				var cornerBy2 = this.startCell.by + 1;

				var px1 = x0 + cornerBx1 * bw;
				var py1 = y0 + cornerBy1 * bh;
				var px2 = x0 + cornerBx2 * bw;
				var py2 = y0 + cornerBy2 * bh;

				ctx.strokeStyle = 'rgba(0, 120, 215, 0.8)';
				ctx.lineWidth = 2;
				ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);
			}
		},

		//---------------------------------------------------------------------------
		// manager.drawPastePreview() ペーストプレビューを描画する
		//---------------------------------------------------------------------------
		drawPastePreview: function() {
			if (!this.pastePreviewPos) {
				return;
			}

			var overlay = this.overlayCanvas;
			if (!overlay) {
				return;
			}
			this._updateOverlaySizePos();
			overlay.style.display = 'block';

			var ctx = overlay.getContext('2d');
			var dpr = overlay._dpr || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr);

			var painter = this.puzzle.painter;
			var bw = painter.bw;
			var bh = painter.bh;
			var x0 = painter.x0;
			var y0 = painter.y0;

			var data = this.getTransformedData();
			if (!data || data.length === 0) {
				return;
			}
			var bx = this.pastePreviewPos.bx;
			var by = this.pastePreviewPos.by;
			var endBx = bx + (data[0].length - 1) * 2;
			var endBy = by + (data.length - 1) * 2;

			// セル中心座標から罫線交点座標に変換
			var cornerBx1 = bx - 1;
			var cornerBy1 = by - 1;
			var cornerBx2 = endBx + 1;
			var cornerBy2 = endBy + 1;

			var px1 = x0 + cornerBx1 * bw;
			var py1 = y0 + cornerBy1 * bh;
			var px2 = x0 + cornerBx2 * bw;
			var py2 = y0 + cornerBy2 * bh;

			// 薄青色の半透明塗りつぶし
			ctx.fillStyle = 'rgba(135, 206, 235, 0.3)';
			ctx.fillRect(px1, py1, px2 - px1, py2 - py1);

			this.drawPasteGhostData(ctx, data, bx, by);

			// 青い枠線
			ctx.strokeStyle = 'rgba(0, 120, 215, 0.8)';
			ctx.lineWidth = 2;
			ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);
		},

		//---------------------------------------------------------------------------
		// manager.hideSelectionOverlay() 選択範囲を非表示にする
		//---------------------------------------------------------------------------
		hideSelectionOverlay: function() {
			if (this.overlayCanvas) {
				this.overlayCanvas.style.display = 'none';
				var ctx = this.overlayCanvas.getContext('2d');
				var dpr = this.overlayCanvas._dpr || 1;
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, this.overlayCanvas.width / dpr, this.overlayCanvas.height / dpr);
			}
		},

		//---------------------------------------------------------------------------
		// manager.updateButtonState() ボタンの表示状態を更新する
		//---------------------------------------------------------------------------
		updateButtonState: function() {
			var btnCopy = document.getElementById('btn_copy');
			var btnPaste = document.getElementById('btn_paste');
			var btnRotate = document.getElementById('btn_rotate90');
			var btnFlip = document.getElementById('btn_fliph');

			if (btnCopy) {
				if (this.mode === 'selecting') {
					btnCopy.classList.add('active');
				} else {
					btnCopy.classList.remove('active');
				}
			}

			if (btnPaste) {
				if (this.mode === 'pasting') {
					btnPaste.classList.add('active');
				} else {
					btnPaste.classList.remove('active');
				}
			}

			if (btnRotate) {
				if (this.rotateStep !== 0) {
					btnRotate.classList.add('active');
				} else {
					btnRotate.classList.remove('active');
				}
			}

			if (btnFlip) {
				if (this.flipH) {
					btnFlip.classList.add('active');
				} else {
					btnFlip.classList.remove('active');
				}
			}
		},

		//---------------------------------------------------------------------------
		// manager.rotate90Toggle() 90度回転を進める
		//---------------------------------------------------------------------------
		rotate90Toggle: function() {
			if (!this.copiedData || this.copiedData.length === 0) {
				return;
			}
			this.rotateStep = (this.rotateStep + 1) % 4;
			if (this.mode === 'pasting') {
				this.drawPastePreview();
			}
			this.updateButtonState();
		},

		//---------------------------------------------------------------------------
		// manager.flipHToggle() 左右反転の切り替え
		//---------------------------------------------------------------------------
		flipHToggle: function() {
			if (!this.copiedData || this.copiedData.length === 0) {
				return;
			}
			this.flipH = !this.flipH;
			if (this.mode === 'pasting') {
				this.drawPastePreview();
			}
			this.updateButtonState();
		},

		//---------------------------------------------------------------------------
		// manager.getTransformedData() 回転/反転を適用したデータを返す
		//---------------------------------------------------------------------------
		getTransformedData: function() {
			var data = this.copiedData;
			if (!data || data.length === 0) {
				return [];
			}

			if (this.rotateStep !== 0) {
				data = this.rotateData(data, this.rotateStep);
			}
			if (this.flipH) {
				data = this.flipHData(data);
			}
			return data;
		},

		rotateData: function(data, step) {
			var result = data;
			for (var i = 0; i < step; i++) {
				result = this.rotate90Data(result);
			}
			return result;
		},

		rotate90Data: function(data) {
			var h = data.length;
			var w = data[0].length;
			var out = new Array(w);
			for (var x = 0; x < w; x++) {
				out[x] = new Array(h);
			}
			for (var y = 0; y < h; y++) {
				for (var x = 0; x < w; x++) {
					out[x][h - 1 - y] = data[y][x];
				}
			}
			return out;
		},

		flipHData: function(data) {
			var h = data.length;
			var w = data[0].length;
			var out = new Array(h);
			for (var y = 0; y < h; y++) {
				out[y] = new Array(w);
				for (var x = 0; x < w; x++) {
					out[y][w - 1 - x] = data[y][x];
				}
			}
			return out;
		},

		drawPasteGhostData: function(ctx, data, bx, by) {
			var painter = this.puzzle.painter;
			var bw = painter.bw;
			var bh = painter.bh;
			var x0 = painter.x0;
			var y0 = painter.y0;
			var cellW = bw * 2;
			var cellH = bh * 2;
			var fontSize = Math.max(10, Math.floor(Math.min(cellW, cellH) * 0.6));
			var isLightup = this.puzzle.pid === 'lightup';

			ctx.save();
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.font = fontSize + 'px sans-serif';

			for (var dy = 0; dy < data.length; dy++) {
				var row = data[dy];
				for (var dx = 0; dx < row.length; dx++) {
					var val = row[dx];
					if (val === -1) {
						continue;
					}
					var cellBx = bx + dx * 2;
					var cellBy = by + dy * 2;
					var px1 = x0 + (cellBx - 1) * bw;
					var py1 = y0 + (cellBy - 1) * bh;

					if (isLightup) {
						ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
						ctx.fillRect(px1, py1, cellW, cellH);
					}

					if (val >= 0) {
						var text = String(val);
						ctx.fillStyle = isLightup
							? 'rgba(255, 255, 255, 0.7)'
							: 'rgba(0, 0, 0, 0.6)';
						ctx.fillText(text, x0 + cellBx * bw, y0 + cellBy * bh);
					}
				}
			}
			ctx.restore();
		}
	}
});
