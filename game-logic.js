// @license magnet:?xt=urn:btih:1f739d935676111cfff4b4693e3816e664797050&dn=gpl-3.0.txt GPL-v3
// Copyright (C) 2020-2021 Eklavya Sharma. Licensed under GNU GPLv3.
'use strict';

var arena = document.getElementById('arena');
var inventory = document.getElementById('inventory');
var hoverRect = document.getElementById('hover-rect');

var innerMargin = 10;  // margin between arena and the elements inside it, in px.
var outerMargin = 32;  // margin between arena and containing page.
var defaultItemColor = 'hsl(210,100%,60%)';
var mouseMode = {'item': 'drag', 'bin': null};

var handleKeyPresses = true;
var game = null;
var globalDragData = null;
var uploadInfo = {'scaleFactor': null, 'succHook': null, 'failHook': null};

//==[ Logic Layer ]=============================================================

class Rectangle {
    constructor(xPos, yPos, xLen, yLen) {
        this.xPos = xPos;
        this.yPos = yPos;
        this.xLen = xLen;
        this.yLen = yLen;
    }
}

function array2d(m, n, x) {
/* create m-length list containing n-length lists of element x */
    let arr = [];
    for(let i=0; i<m; ++i) {
        arr.push(new Array(n).fill(x));
    }
    return arr;
}

class DummyBin {
    constructor(xLen, yLen) {
        this.xLen = xLen;
        this.yLen = yLen;
        this.count = 0;
    }

    canFit(rect) {
        return (rect.xPos + rect.xLen <= this.xLen) && (rect.yPos + rect.yLen <= this.yLen);
    }

    isEmpty() {
        return this.count === 0;
    }

    insert(rect) {
        this.count += 1;
        return true;
    }

    remove(rect) {
        if(this.count === 0) {
            return false;
        }
        else {
            this.count -= 1;
            return true;
        }
    }
}

class Bin {
    constructor(xLen, yLen) {
        this.xLen = xLen;
        this.yLen = yLen;
        // this.rects = [];
        this._aggFilled = array2d(yLen+1, xLen+1, 0);
    }

    _getAggFilled(x, y) {
        console.assert(y <= this.yLen, 'y overflow: ', y);
        console.assert(x <= this.xLen, 'x overflow: ', x);
        return this._aggFilled[y][x];
    }
    _incAggFilled(x, y, z) {
        console.assert(y <= this.yLen, 'y overflow: ', y);
        console.assert(x <= this.xLen, 'x overflow: ', x);
        this._aggFilled[y][x] += z;
    }
    getFilledArea(rect) {
        let minX = Math.min(rect.xPos + rect.xLen, this.xLen);
        let minY = Math.min(rect.yPos + rect.yLen, this.yLen);
        return this._getAggFilled(minX, minY)
            - this._getAggFilled(rect.xPos, minY)
            - this._getAggFilled(minX, rect.yPos)
            + this._getAggFilled(rect.xPos, rect.yPos);
    }
    isEmpty() {
        return this._getAggFilled(this.xLen, this.yLen) === 0;
    }

    _fill(rect, z) {
        console.assert(rect.xPos + rect.xLen <= this.xLen, '_fill: x overflow');
        console.assert(rect.yPos + rect.yLen <= this.yLen, '_fill: y overflow');
        for(let i=1; i <= rect.yLen; ++i) {
            let y = rect.yPos + i;
            for(let j=1; j <= rect.xLen; ++j) {
                this._incAggFilled(rect.xPos + j, y, i * j * z);
            }
            for(let x = rect.xPos + rect.xLen + 1; x <= this.xLen; ++x) {
                this._incAggFilled(x, y, i * rect.xLen * z);
            }
        }
        for(let y = rect.yPos + rect.yLen + 1; y <= this.yLen; ++y) {
            for(let j=1; j <= rect.xLen; ++j) {
                this._incAggFilled(rect.xPos + j, y, rect.yLen * j * z);
            }
            let a = rect.yLen * rect.xLen;
            for(let x = rect.xPos + rect.xLen + 1; x <= this.xLen; ++x) {
                this._incAggFilled(x, y, a * z);
            }
        }
    }

    canFit(rect) {
        if((rect.xPos + rect.xLen > this.xLen) || (rect.yPos + rect.yLen > this.yLen)) {
            return false;
        }
        return this.getFilledArea(rect) === 0;
    }

    insert(rect) {
        if(this.canFit(rect)) {
            // this.rects.push(rect);
            this._fill(rect, 1);
            return true;
        }
    }

    remove(rect) {
        this._fill(rect, -1);
        return true;
    }
}

class ItemInfo {
    constructor(id, xLen, yLen, profit, color) {
        this.id = id;
        this.xLen = xLen;
        this.yLen = yLen;
        this.profit = profit;
        this.color = color;
    }

    area() {
        return this.xLen * this.yLen;
    }

    clone() {
        return new ItemInfo(this.id, this.xLen, this.yLen, this.profit, this.color);
    }

    toJSON() {
        return {'id': this.id, 'xLen': this.xLen, 'yLen': this.yLen,
            'profit': this.profit, 'color': this.color};
    }
}

class ItemSetStats {
    constructor(count=0, area=0, profit=0) {
        this.count = count;
        this.area = area;
        this.profit = profit;
    }
    add(itemInfo) {
        this.count += 1;
        this.area += itemInfo.area();
        this.profit += itemInfo.profit;
    }
    remove(itemInfo) {
        this.count -= 1;
        this.area -= itemInfo.area();
        this.profit -= itemInfo.profit;
    }
}

//==[ Util ]====================================================================

function getFirstValue(map) {
    for(let value of map.values()) {
        return value;
    }
}

function arraysEqual(a, b) {
    if(a === b) {return true;}
    if(a === null || b === null) {return false;}
    if(a.length !== b.length) {return false;}
    for(let i = 0; i < a.length; ++i) {
        if(a[i] !== b[i]) {return false;}
    }
    return true;
}

function clip(x, lo, hi) {
    if (x <= lo) {
        return lo;
    }
    else if (x >= hi) {
        return hi;
    }
    else {
        return x;
    }
}

function gcd(a, b) {
    while(true) {
        if(b === 0) {
            return a;
        }
        else {
            a %= b;
        }
        if(a === 0) {
            return b;
        }
        else {
            b %= a;
        }
    }
}

//==[ UI Layer ]================================================================

function setPos(domElem, xPos, yPos) {
    domElem.style.top = yPos + 'px';
    domElem.style.left = xPos + 'px';
}

function changeDomParent(node, parentNode) {
    let nodeRect = node.getBoundingClientRect();
    let parentRect = parentNode.getBoundingClientRect();
    setPos(node, nodeRect.x - parentRect.x, nodeRect.y - parentRect.y);
    parentNode.appendChild(node);
}

class ItemUI {
    constructor(itemInfo, scaleFactor) {
        this.itemInfo = itemInfo;
        this.xPos = null;
        this.yPos = null;
        this.binUI = null;

        // DOM
        this.domElem = document.createElement('div');
        this.domElem.classList.add('item');
        this.domElem.setAttribute('data-item-id', this.itemInfo.id);
        this.setColor(itemInfo.color);
        this.resize(scaleFactor);
    }

    setColor(color) {
        if(color !== null) {
            this.domElem.style.backgroundColor = color;
        }
        else {
            this.domElem.style.backgroundColor = defaultItemColor;
        }
    }

    resize(scaleFactor) {
        this.domElem.style.width = scaleFactor * this.itemInfo.xLen + 'px';
        this.domElem.style.height = scaleFactor * this.itemInfo.yLen + 'px';
        if(this.binUI !== null) {
            setPos(this.domElem, scaleFactor * this.xPos, scaleFactor * this.yPos);
        }
    }
}

class BinUI {
    constructor(xLen, yLen, dummy, id, scaleFactor) {
        if(dummy) {
            this.bin = new DummyBin(xLen, yLen);
        }
        else {
            this.bin = new Bin(xLen, yLen);
        }
        this.id = id;

        this.domElem = document.createElement('div');
        this.domElem.classList.add('bin');
        this.domElem.setAttribute('data-bin-id', this.id);
        this.resize(scaleFactor);
    }

    resize(scaleFactor) {
        this.domElem.style.width = this.bin.xLen * scaleFactor + 'px';
        this.domElem.style.height = this.bin.yLen * scaleFactor + 'px';
        this.domElem.style.backgroundSize = scaleFactor + 'px ' + scaleFactor + 'px';
    }

    destroy() {
        if(this.bin.isEmpty()) {
            let packingArea = document.getElementById('packing-area');
            packingArea.removeChild(this.domElem);
            this.bin = null;
            this.domElem = null;
        }
        else {
            throw new Error('attempt to destroy non-empty bin');
        }
    }
}

function createBarItems(domParent, names) {
    let domElems = {};
    for(let name of names) {
        let entryDom = document.createElement('div');
        entryDom.classList.add('bar-entry');
        let labelDom = document.createElement('div');
        labelDom.classList.add('bar-label');
        labelDom.innerHTML = name;
        let valueDom = document.createElement('div');
        valueDom.classList.add('bar-value');
        domElems[name] = valueDom;
        entryDom.appendChild(labelDom);
        entryDom.appendChild(valueDom);
        domParent.appendChild(entryDom);
    };
    return domElems;
}

function inferScaleFactors(invXLen, invYLen, binXLen, binYLen, nBins=1) {
    nBins = Math.max(1, nBins);
    const bodyRect = document.body.getBoundingClientRect();
    const persistentFooterHeight = document.getElementById('footer')
        .getBoundingClientRect().height;
    const arenaX = Math.min(window.innerWidth, bodyRect.width) - 2 * outerMargin;
    const arenaY = Math.min(window.innerHeight, bodyRect.height)
        - 2 * outerMargin - persistentFooterHeight - getPersistentHeaderHeight();
    let binGridDims = [];
    for(let i=1; i*(i-1) < nBins; ++i) {
        const j = Math.ceil(nBins / i);
        binGridDims.push([i, j], [j, i]);
    }

    function inferScaleFactorsHelper(rows, cols) {
        const scaleX = (arenaX - (cols + 3) * innerMargin) / (invXLen + cols * binXLen);
        const scaleY1 = (arenaY - 2 * innerMargin) / invYLen;
        const scaleY2 = (arenaY - innerMargin * (rows + 1)) / (rows * binYLen);
        return [scaleX, Math.min(scaleY1, scaleY2)];
    }

    const [hScaleX, hScaleY] = inferScaleFactorsHelper(nBins, 1);
    let finalScale = 0;
    let scaleReason = null;
    for(const [rows, cols] of binGridDims) {
        const [scaleX, scaleY] = inferScaleFactorsHelper(rows, cols);
        const scale = Math.min(scaleX, scaleY);
        if(scale > finalScale) {
            finalScale = scale;
            scaleReason = [rows, cols];
        }
    }
    console.debug("inferred scales:", finalScale, hScaleX, finalScale, scaleReason);
    return [finalScale, hScaleX, finalScale];
}

function roundScaleFactors(factors) {
    const devicePixelRatio = window.devicePixelRatio;
    for(let i=0; i < factors.length; ++i) {
        if(factors[i] * devicePixelRatio > 20) {
            factors[i] = Math.floor(devicePixelRatio * factors[i]) / devicePixelRatio;
        }
    }
    return factors;
}

function arraySwap(arr, i, j) {
    let t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
}

class Game {

    constructor(level, scaleFactor=null) {
        this.level = level;
        this._computeInventoryDimsAndItemHomePositions();
        this._computeAutoPack('ffdh-ff');
        this._computeAutoPack('ffdh-ff-mirror');
        this._improveLowerBound();
        this.won = false;

        this.itemInfoBar = new ItemInfoBar(this.level.gameType);
        this.history = [];
        this.historyLength = 0;
        this.bins = [];
        this.items = [];
        this.totalStats = new ItemSetStats();
        this.packedStats = new ItemSetStats();
        this.nBinsUsed = 0;

        this._createStatsBar();
        this._startTimer();
        this._setScaleFactor(scaleFactor);
        this._createItems();
        this._createBinsAndPackItems(this.level.startPos);
        this._refreshStatsDom();
        repopulateSolutionsMenu(this.level.solutions);
        repopulateAutoPackMenu();
    }

    getItemPosition(itemId) {
        let item = this.items[itemId];
        if(item.binUI !== null) {
           return [item.binUI.id, item.xPos, item.yPos];
        }
        else {
            return null;
        }
    }

    getItemPositions() {
        let pos = [];
        let consecNulls = 0;
        for(let i=0; i < this.items.length; ++i) {
            let coords = this.getItemPosition(i);
            pos.push(coords);
            if(coords === null) {
                consecNulls += 1;
            }
            else {
                consecNulls = 0;
            }
        }
        pos.length -= consecNulls;
        return pos;
    }

    putBack(pos=null) {
        this._moveItemsToInventory(false);
        this._destroyBins();
        if(pos === null) {
            pos = [];
        }
        this._createBinsAndPackItems(pos);
    }

    addBins(nBin) {
        for(let i=0; i<nBin; ++i) {
            let bin = new BinUI(this.level.binXLen, this.level.binYLen, false,
                this.bins.length, this.scaleFactor);
            this.bins.push(bin);
            let packingArea = document.getElementById('packing-area');
            packingArea.appendChild(bin.domElem);
        }
    }

    trimBins(targetEmpty) {
        let nEmpty = 0;
        let nBins = this.bins.length;
        for(; nEmpty < nBins && this.bins[nBins - nEmpty - 1].bin.isEmpty(); ++nEmpty);

        if(nEmpty < targetEmpty) {
            this.addBins(targetEmpty - nEmpty);
        }
        else {
            for(let i=1; i <= nEmpty - targetEmpty; ++i) {
                this.bins[nBins - i].destroy();
            }
            this.bins.length = nBins - nEmpty + targetEmpty;
        }
    }

    repackInventory(origInvXLen=null) {
        this._computeInventoryDimsAndItemHomePositions(origInvXLen);
        this._setInventoryDimsPx();
        for(let i=0; i < this.items.length; ++i) {
            let item = this.items[i];
            if(item.binUI === null) {
                setPos(item.domElem, this.stripPackSol[i][0] * this.scaleFactor,
                    this.stripPackSol[i][1] * this.scaleFactor);
            }
        }
    }

    detach(itemId, asyncDomChange=false) {
        let item = this.items[itemId];
        if(item.binUI !== null) {
            item.binUI.bin.remove(new Rectangle(item.xPos, item.yPos,
                item.itemInfo.xLen, item.itemInfo.yLen));
            this.packedStats.remove(item.itemInfo);
            if(item.binUI.bin.isEmpty()) {
                this.nBinsUsed--;
            }
            item.binUI = null;
            let changeFunc = () => changeDomParent(item.domElem, inventory);
            if(asyncDomChange) {
                window.setTimeout(changeFunc);
            }
            else {
                changeFunc();
            }
            this._assessBins();
        }
    }

    attach(itemId, binId, xPos, yPos, asyncDomChange=false) {
        let item = this.items[itemId];
        let binUI = this.bins[binId];
        if(binUI === undefined) {
            throw new Error('Cannot attach item ' + itemId
                + '; bin ' + binId + ' does not exist.');
        }
        console.assert(item.binUI === null, 'item ' + itemId
            + ' is already attached to bin ' + binId);
        let wasEmpty = binUI.bin.isEmpty();
        if(binUI.bin.insert(new Rectangle(xPos, yPos, item.itemInfo.xLen, item.itemInfo.yLen))) {
            item.binUI = binUI;
            item.xPos = xPos;
            item.yPos = yPos;
            this.packedStats.add(item.itemInfo);
            if(wasEmpty) {
                this.nBinsUsed++;
            }
            let changeFunc = () => {
                changeDomParent(item.domElem, item.binUI.domElem);
                setPos(item.domElem, this.scaleFactor * xPos, this.scaleFactor * yPos);
            };
            if(asyncDomChange) {
                window.setTimeout(changeFunc);
            }
            else {
                changeFunc();
            }
            this._assessBins();
            return true;
        }
        else {
            return false;
        }
    }

    undo() {
        if(this.historyLength === 0) {
            return;
        }
        let cmd = this.history[--this.historyLength];
        this._executeCommand(cmd, true);
        this._resetHistoryButtons();
    }

    redo() {
        if(this.historyLength === this.history.length) {
            return;
        }
        let cmd = this.history[this.historyLength++];
        this._executeCommand(cmd, false);
        this._resetHistoryButtons();
    }

    selectAutoPack(algoName, packName=null, succHook=null, failHook=null, logger=null) {
        let thisGame = this;
        function succHook2(packObj) {
            let packings = packObj.packings;
            if(packings.size > 0) {
                let packing;
                if(packName === null) {
                    packing = getFirstValue(packings);
                }
                else {
                    packing = packings.get(packName);
                    if(packing === undefined) {
                        throw new Error(`packing ${algoName}.${packName} not found.`);
                    }
                }
                let oldPos = thisGame.getItemPositions();
                thisGame._recordHistoryCommand(
                    {'cmd': 'bulkMove', 'oldPos': oldPos, 'newPos': packing});
                thisGame.putBack(packing);
            }
            else {
                addMsg('warning', 'No packings were output by the packer.');
            }
            if(succHook !== null) {
                succHook();
            }
        }
        this._computeAutoPack(algoName, succHook2, failHook, logger);
    }

    selectSolution(solnName) {
        let newPos = this.level.solutions.get(solnName);
        let oldPos = this.getItemPositions();
        this._recordHistoryCommand({'cmd': 'bulkMove', 'oldPos': oldPos, 'newPos': newPos});
        this.won = true;
        this.endTime = Date.now();
        this.putBack(newPos);
    }

    resize(scaleFactor) {
        this._setScaleFactor(scaleFactor);
        for(let bin of this.bins) {
            bin.resize(this.scaleFactor);
        }
        for(let i=0; i < this.items.length; ++i) {
            let item = this.items[i];
            item.resize(this.scaleFactor);
            if(item.binUI === null) {
                this._moveItemToInventory(i);
            }
        }
    }

    improveBounds() {
        this._improveLowerBound();
        this._computeAutoPack('ffdh-ff');
        this._computeAutoPack('ffdh-ff-mirror');
        this._assessBins();
    }

    lowerBound() {
        if(this.level.origLB === null) {
            return this.level.computedLB;
        }
        else {
            return Math.max(this.level.computedLB, this.level.origLB);
        }
    }
    upperBound() {
        if(this.level.origUB === null) {
            return this.level.computedUB;
        }
        else {
            return Math.min(this.level.computedUB, this.level.origUB);
        }
    }

    popItem() {
        this.won = true;
        const itemId = this.level.items.length - 1;
        if(itemId < 0) {
            console.warn('nothing to pop');
            return;
        }
        this.detach(itemId);
        inventory.removeChild(this.items[itemId].domElem);
        this.totalStats.remove(this.level.items[itemId]);
        this.level.startPos = [];
        this.level.solutions.clear();
        this.stripPackSol.pop();
        this._invalidateLowerBound();
        this.level.computedUBReason = null;
        this.level.autoPack.clear();
        this.items.pop();
        this.level.items.pop();
        this.repackInventory();
        this.trimBins(1);
        this._assessBins();
    }

    _swapItems(i1, i2) {
        if(i1 === i2) {
            return;
        }

        arraySwap(this.level.startPos, i1, i2);
        for(let [solnName, soln] of this.level.solutions.entries()) {
            arraySwap(soln, i1, i2);
        }
        for(let [algoName, packing] of this.level.autoPack.entries()) {
            arraySwap(packing, i1, i2);
        }
        arraySwap(this.stripPackSol, i1, i2);
        arraySwap(this.items, i1, i2);
        arraySwap(this.level.items, i1, i2);
        this.items[i1].domElem.setAttribute('data-item-id', i1);
        this.level.items[i1].id = i1;
        this.items[i2].domElem.setAttribute('data-item-id', i2);
        this.level.items[i2].id = i2;
    }

    removeItem(itemId) {
        this.won = true;
        this._swapItems(itemId, this.items.length - 1);
        this.popItem();
    }

    modifyItem(itemId, itemInfo) {
        this.won = true;
        if(itemId >= this.items.length) {
            throw new Error('item ' + itemId + ' does not exist.');
        }
        let item = this.items[itemId];
        if(item.binUI !== null) {
            this.detach(itemId);
        }
        this._invalidateHistory();
        this.level.items[itemId] = itemInfo;
        item.itemInfo = itemInfo;
        itemInfo.id = itemId;
        item.setColor(itemInfo.color);
        item.resize(this.scaleFactor);
        this.totalStats.remove(this.level.items[itemId]);
        this.totalStats.add(this.level.items[itemId]);
        this.level.startPos[itemId] = null;
        this.level.solutions.clear();
        this.level.autoPack.clear();
        this._invalidateLowerBound();
        this._invalidateUpperBound();
        repopulateSolutionsMenu(this.level.solutions);
        this._assessBins();
    }

    hardRotate(itemId) {
        this.won = true;
        if(itemId >= this.items.length) {
            throw new Error('item ' + itemId + ' does not exist.');
        }
        let newItemInfo = this.level.items[itemId].clone();
        [newItemInfo.xLen, newItemInfo.yLen] = [newItemInfo.yLen, newItemInfo.xLen];
        this.modifyItem(itemId, newItemInfo);
    }

    pushItem(itemInfo) {
        this.won = true;
        const itemId = this.items.length;
        itemInfo.id = itemId;
        this.level.items.push(itemInfo);
        let itemUI = new ItemUI(itemInfo, this.scaleFactor);
        this.items.push(itemUI);
        this.totalStats.add(itemInfo);
        this.stripPackSol.push([0, this.invYLen]);
        /*
        this.invYLen += itemInfo.yLen;
        this.invXLen = Math.max(this.invXLen, itemInfo.xLen);
        this._setInventoryDimsPx();
        */
        this.repackInventory();
        this._moveItemToInventory(itemId);
        inventory.appendChild(itemUI.domElem);

        this.level.startPos.push(null);
        this.level.solutions.clear();
        repopulateSolutionsMenu(this.level.solutions);
        this._invalidateUpperBound();
        this.level.computedLBReason = null;
        this.level.autoPack.clear();
        this._assessBins();
    }

    destroy() {
        this._destroyItems();
        this._destroyBins();
        this.invXLen = 0;
        this.invYLen = 0;
        this._setInventoryDimsPx();
        arena.classList.remove('large');
        this._invalidateHistory();
        this.totalStats = null;
        this.packedStats = null;
        this._destroyTimer();
        this._destroyStatsBar();
        this.itemInfoBar.destroy();
        this.level = null;
        this.stripPackSol = null;
        inventory.style.backgroundSize = null;
    }

    _invalidateLowerBound() {
        this.level.origLB = null;
        const binArea = this.level.binXLen * this.level.binYLen;
        this.level.computedLB = Math.ceil(this.totalStats.area / binArea);
        this.level.computedLBReason = 'area';
    }

    _invalidateUpperBound() {
        const binArea = this.level.binXLen * this.level.binYLen;
        this.level.origUB = null;
        this.level.computedUB = this.items.length;
        this.level.computedUBReason = 'n';
        const areaBound = Math.ceil(4 * this.totalStats.area / binArea) + 1;
        if(areaBound < this.level.computedUB) {
            this.level.computedUB = areaBound;
            this.level.computedUBReason = 'nfdh-area';
        }
    }

    _computeAutoPack(algoName, succHook=null, failHook=null, logger=null) {
        let level = this.level;
        let cachedPackObj = level.autoPack.get(algoName);
        if(cachedPackObj === undefined || !cachedPackObj.deterministic) {
            let packer = packers.get(algoName);
            function succHook2(packObj) {
                level.autoPack.set(algoName, packObj);
                for(let [packName, packing] of packObj.packings) {
                    const [nBins, nPacked] = countUsedBinsAndPackedItems(packing);
                    const computedUB = nBins + level.items.length - nPacked;
                    if(computedUB < level.computedUB) {
                        level.computedUBReason = algoName + '.' + packName;
                        level.computedUB = computedUB;
                    }
                }
                if(succHook !== null) {
                    succHook(packObj);
                }
            }
            packer(level.items, level.binXLen, level.binYLen, succHook2, failHook, logger);
        }
        else if(succHook !== null) {
            succHook(cachedPackObj);
        }
    }

    _improveLowerBound() {
        let level = this.level;
        const [newLB, newLBReason] = bpLowerBound(level.items, level.binXLen, level.binYLen, false);
        if(newLB > level.computedLB) {
            level.computedLBReason = newLBReason;
            level.computedLB = newLB;
        }
    }

    _refreshStatsDom() {
        let d = {
            'packed': this.packedStats.count,
            'unpacked': this.items.length - this.packedStats.count,
            'bins used': this.nBinsUsed,
            'profit': this.packedStats.profit,
        };
        for(let [key, value] of Object.entries(d)) {
            let domElem = this.statsDomElems[key];
            if(domElem !== undefined) {
                domElem.innerHTML = value;
            }
        }
        if(d['unpacked'] === 0) {
            this.statsDomElems['packed'].classList.add('success');
            this.statsDomElems['unpacked'].classList.add('success');
        }
        else {
            this.statsDomElems['packed'].classList.remove('success');
            this.statsDomElems['unpacked'].classList.remove('success');
        }
        let binsUsedDomElem = this.statsDomElems['bins used'];
        binsUsedDomElem.classList.remove('success', 'error', 'warning');
        if(this.nBinsUsed > this.upperBound()) {
            binsUsedDomElem.classList.add('error');
        }
        else if(this.nBinsUsed > this.lowerBound()) {
            binsUsedDomElem.classList.add('warning');
        }
        else {
            binsUsedDomElem.classList.add('success');
        }
    }

    _assessBins() {
        let lb = this.lowerBound(), ub = this.upperBound();
        let used = 0;
        let binTypes = [];
        for(let i=0; i<this.bins.length; ++i) {
            let bin = this.bins[i];
            if(!bin.bin.isEmpty()) {
                used += 1
                let binType = 'good';
                if(used > ub) {
                    binType = 'danger';
                }
                else if(used > lb) {
                    binType = 'warning';
                }
                binTypes.push(binType);
                bin.domElem.setAttribute('data-bin-type', binType);
            }
            else {
                binTypes.push(null);
                bin.domElem.removeAttribute('data-bin-type');
            }
        }
        this._refreshStatsDom();
        if(!this.won) {
            if(this.packedStats.count === this.items.length && used <= lb) {
                this.won = true;
                this.endTime = Date.now();
                window.setTimeout(showCelebration, 100);
            }
        }
        return binTypes;
    }

    _invalidateHistory() {
        this.history = [];
        this.historyLength = 0;
        disableUndoButton();
        disableRedoButton();
    }

    _recordMove(itemId, oldCoords, newCoords) {
        if(!arraysEqual(oldCoords, newCoords)) {
            let cmd = {'cmd': 'move', 'itemId': itemId,
                'oldCoords': oldCoords, 'newCoords': newCoords};
            this._recordHistoryCommand(cmd);
        }
    }

    _recordHistoryCommand(cmd) {
        this.history[this.historyLength++] = cmd;
        this.history.length = this.historyLength;
        this._resetHistoryButtons();
    }

    _resetHistoryButtons() {
        if(this.historyLength > 0) {
            enableUndoButton();
        }
        else {
            disableUndoButton();
        }
        if(this.historyLength === this.history.length) {
            disableRedoButton();
        }
        else {
            enableRedoButton();
        }
    }

    _executeCommand(cmd, opposite) {
        if(cmd.cmd === 'move') {
            let coords;
            if(opposite) {
                coords = cmd.oldCoords;
            }
            else {
                coords = cmd.newCoords;
            }
            let item = this.items[cmd.itemId];
            if(coords === null) {
                this._moveItemToInventory(cmd.itemId);
                this.trimBins(1);
            }
            else if(coords[0] >= this.bins.length) {
                this.addBins(coords[0] + 2 - this.bins.length);
                this.detach(cmd.itemId);
                this.attach(cmd.itemId, coords[0], coords[1], coords[2]);
            }
            else {
                // check if moving will cause clash. If yes, invalidate history and warn.
                let bin = this.bins[coords[0]];
                let currCoords = this.getItemPosition(cmd.itemId);
                let newPosRect = new Rectangle(coords[1], coords[2],
                    item.itemInfo.xLen, item.itemInfo.yLen);
                this.detach(cmd.itemId);
                if(bin.bin.canFit(newPosRect)) {
                    this.attach(cmd.itemId, coords[0], coords[1], coords[2]);
                    this.trimBins(1);
                }
                else {
                    if(currCoords !== null) {
                        this.attach(cmd.itemId, currCoords[0], currCoords[1], currCoords[2]);
                    }
                    console.warn('undo/redo failed: cannot move item ' + cmd.itemId
                        + ' to position ' + coords + '; invalidating history.');
                    this._invalidateHistory();
                }
            }
        }
        else if(cmd.cmd === 'addItem') {
            if(opposite) {
                this.popItem();
            }
            else {
                let itemInfo = new ItemInfo(null, cmd.xLen, cmd.yLen, 0, null);
                this.pushItem(itemInfo);
                if(cmd.coords !== null && cmd.coords !== undefined) {
                    const success = this.attach(this.items.length - 1, cmd.coords[0], cmd.coords[1],
                        cmd.coords[2]);
                    this.trimBins(1);
                    if(!success) {
                        console.warn('undo/redo failed: cannot move item '
                            + (this.items.length - 1) + ' to position '
                            + cmd.coords + '; invalidating history.');
                        this._invalidateHistory();
                    }
                }
            }
        }
        else if(cmd.cmd === 'removeItem') {
            if(opposite) {
                let itemInfo = new ItemInfo(null, cmd.xLen, cmd.yLen, cmd.profit, cmd.color);
                this.pushItem(itemInfo);
                if(cmd.coords !== null && cmd.coords !== undefined) {
                    if(cmd.coords[0] >= this.bins.length) {
                        this.addBins(cmd.coords[0] + 2 - this.bins.length);
                        this.attach(this.items.length - 1, cmd.coords[0],
                            cmd.coords[1], cmd.coords[2]);
                    }
                    else {
                        const success = this.attach(this.items.length - 1,
                            cmd.coords[0], cmd.coords[1], cmd.coords[2]);
                        if(!success) {
                            console.warn('undo/redo failed: cannot move item '
                                + cmd.itemId + ' to position '
                                + cmd.coords + '; invalidating history.');
                            this._invalidateHistory();
                        }
                    }
                }
                this._swapItems(cmd.itemId, this.items.length - 1);
            }
            else {
                this.removeItem(cmd.itemId);
            }
        }
        else if(cmd.cmd === 'bulkMove') {
            if(opposite) {
                this.putBack(cmd.oldPos);
            }
            else {
                this.putBack(cmd.newPos);
            }
        }
        else {
            this._invalidateHistory();
            throw new Error('unknown command ' + cmd.cmd);
        }
    }

    _computeInventoryDimsAndItemHomePositions(origInvXLen=null) {
        let rawItems = this.level.items;
        let maxXLen = this.level.binXLen;
        let area = 0;
        for(let item of rawItems) {
            maxXLen = Math.max(maxXLen, item.xLen);
            area += item.xLen * item.yLen;
        }
        if(origInvXLen === null) {
            origInvXLen = Math.floor(Math.sqrt(area));
        }
        if(origInvXLen < maxXLen) {
            origInvXLen = maxXLen;
        }
        this.stripPackSol = nfdhStripPack(rawItems, origInvXLen);
        [this.invXLen, this.invYLen] = getStripDims(rawItems, this.stripPackSol);
    }

    _setScaleFactor(scaleFactor) {
        let [inferredScale, inferredScaleX, inferredScaleY] = inferScaleFactors(
            this.invXLen, this.invYLen, this.level.binXLen, this.level.binYLen,
            this.lowerBound());
        [inferredScale, inferredScaleX, inferredScaleY] = roundScaleFactors(
            [inferredScale, inferredScaleX, inferredScaleY]);
        if(scaleFactor === 'x') {
            this.scaleFactor = inferredScaleX;
        }
        else if(scaleFactor === 'y') {
            this.scaleFactor = inferredScaleY;
        }
        else if(scaleFactor === null) {
            this.scaleFactor = inferredScale;
        }
        else {
            this.scaleFactor = scaleFactor;
        }
        let actualArenaWidth = (this.invXLen + this.level.binXLen) * this.scaleFactor
            + 4 * innerMargin;
        const bodyRect = document.body.getBoundingClientRect();
        let spaceForArenaWidth = Math.min(window.innerWidth, bodyRect.width) - 2 * outerMargin;
        if(actualArenaWidth >= spaceForArenaWidth) {
            arena.classList.add('large');
        }
        else {
            arena.classList.remove('large');
        }
        this._setInventoryDimsPx();
    }

    _setInventoryDimsPx() {
        inventory.style.width = this.invXLen * this.scaleFactor + 'px';
        inventory.style.height = this.invYLen * this.scaleFactor + 'px';
        inventory.style.backgroundSize = this.scaleFactor + 'px ' + this.scaleFactor + 'px';
    }

    _createItems() {
        let rawItems = this.level.items;
        for(let i=0; i < rawItems.length; ++i) {
            let itemUI = new ItemUI(rawItems[i], this.scaleFactor);
            this.items.push(itemUI);
            this.totalStats.add(rawItems[i]);
        }
        this._moveItemsToInventory(true);
    }

    _createStatsBar() {
        let domElemNames = ['packed', 'unpacked'];
        if(this.level.gameType === 'bp') {
            domElemNames.push('bins used');
        }
        else if(this.level.gameType === 'ks') {
            domElemNames.push('profit');
        }
        domElemNames.push('time');
        this.statsDomElems = createBarItems(document.getElementById('stats-bar'), domElemNames);
    }

    _destroyStatsBar() {
        document.getElementById('stats-bar').innerHTML = '';
        this.statsDomElems = null;
    }

    _moveItemsToInventory(firstTime) {
        this.yAgg = 0;
        let n = this.items.length;
        for(let i=0; i<n; ++i) {
            let item = this.items[i];
            this.detach(i);
            if(firstTime) {
                inventory.appendChild(item.domElem);
            }
            setPos(item.domElem, this.stripPackSol[i][0] * this.scaleFactor,
                this.stripPackSol[i][1] * this.scaleFactor);
            this.yAgg += item.itemInfo.yLen;
        }
    }

    _moveItemToInventory(itemId) {
        let item = this.items[itemId];
        this.detach(itemId);
        setPos(item.domElem, this.stripPackSol[itemId][0] * this.scaleFactor,
            this.stripPackSol[itemId][1] * this.scaleFactor);
    }

    _createBinsAndPackItems(pos) {
        let binsNeeded = 1;
        let rawItems = this.level.items;
        for(let i=0; i < pos.length && i < rawItems.length; ++i) {
            if(pos[i] !== null && pos[i] !== undefined) {
                binsNeeded = Math.max(binsNeeded, pos[i][0] + 2);
            }
        }
        this.addBins(binsNeeded);

        // move items as per pos
        for(let i=0; i < pos.length && i < rawItems.length; ++i) {
            if(pos[i] !== null && pos[i] !== undefined) {
                let [binId, xPos, yPos] = pos[i];
                this.attach(i, binId, xPos, yPos);
            }
        }
    }

    _destroyBins() {
        for(let bin of this.bins) {
            bin.destroy();
        }
        this.bins.length = 0;
    }

    _destroyItems() {
        this.yAgg = 0;
        for(let i=0; i < this.items.length; ++i) {
            this.detach(i);
            let item = this.items[i];
            inventory.removeChild(item.domElem);
        }
        this.items.length = 0;
    }

    _startTimer() {
        this.startTime = Date.now();
        this.endTime = null;
        this.timerId = setInterval(showTime, 100);
    }

    _destroyTimer() {
        clearInterval(this.timerId);
    }
}

function timeToString(delta) {
    var ds = Math.floor(delta / 100);
    var s = Math.floor(delta / 1000);
    var m = Math.floor(delta / 60000);
    var h = Math.floor(delta / 3600000);
    ds -= s * 10
    s -= 60 * m;
    m -= 60 * h;
    var hStr = (h > 0 ? h + ':' : '');
    var mStr = m.toString().padStart(2, '0') + ':';
    var sStr = s.toString().padStart(2, '0') + '.';
    return hStr + mStr + sStr + ds;
}

function showTime() {
    if (game === null) {
        console.warn('game is null but printTime is still running.')
    }
    else if (game.won) {
        clearInterval(game.timerId);
        if (game.endTime !== null) {
            var delta = game.endTime - game.startTime;
            game.statsDomElems['time'].innerHTML = timeToString(delta);
        }
    }
    else {
        var delta = Date.now() - game.startTime;
        game.statsDomElems['time'].innerHTML = timeToString(delta);
    }
}

function setMouseMode(key, mode) {
    if(mode === '') {mode = null;}
    if(mouseMode[key] === mode) {return;}
    if(mouseMode[key] === null) {
        arena.classList.add(key + '-touch');
    }
    if(mode === null) {
        arena.classList.remove(key + '-touch');
    }
    mouseMode[key] = mode;
}

function clearGame() {
    if(game !== null) {
        game.destroy();
        game = null;
    }
}

function coordListGcds(coordList, gX=0, gY=0) {
    if(gX === 1 && gY === 1) {
        return [gX, gY];
    }
    for(const coords of coordList) {
        if(coords !== null) {
            const [binId, xPos, yPos] = coords;
            gX = gcd(gX, xPos);
            gY = gcd(gY, yPos);
        }
    }
    return [gX, gY];
}

function modifyCoordList(coordList, xMult, yMult, xDiv, yDiv) {
    for(let i=0; i < coordList.length; ++i) {
        if(coordList[i] !== null) {
            let [binId, xPos, yPos] = coordList[i];
            console.assert((xPos * xMult) % xDiv === 0, 'modifyCoordList: rouge xDiv ' + xDiv);
            xPos = (xPos * xMult) / xDiv;
            console.assert((yPos * yMult) % yDiv === 0, 'modifyCoordList: rouge yDiv ' + yDiv);
            yPos = (yPos * yMult) / yDiv;
            coordList[i] = [binId, xPos, yPos];
        }
    }
}

function getGranularity(level) {
    let gX = 0, gY = 0;
    for(const item of level.items) {
        gX = gcd(gX, item.xLen);
        gY = gcd(gY, item.yLen);
    }
    [gX, gY] = coordListGcds(level.startPos, gX, gY);
    for(const [solnName, soln] of level.solutions.entries()) {
        [gX, gY] = coordListGcds(soln, gX, gY);
    }
    for(const [algoName, packing] of level.autoPack.entries()) {
        [gX, gY] = coordListGcds(packing, gX, gY);
    }
    return [gX, gY];
}

function rescaleLevel(level, xMult, yMult, xDiv=1, yDiv=1) {
    modifyCoordList(level.startPos, xMult, yMult, xDiv, yDiv);
    for(let [solnName, soln] of level.solutions) {
        modifyCoordList(soln, xMult, yMult, xDiv, yDiv);
    }
    for(let [algoName, packing] of level.autoPack) {
        modifyCoordList(packing, xMult, yMult, xDiv, yDiv);
    }

    console.assert((xMult * level.binXLen) % xDiv === 0,
        `xDiv=${xDiv} does not divide binXLen=${level.binXLen}`);
    console.assert((yMult * level.binYLen) % yDiv === 0,
        `yDiv=${yDiv} does not divide binYLen=${level.binYLen}`);
    level.binXLen = (xMult * level.binXLen) / xDiv;
    level.binYLen = (yMult * level.binYLen) / yDiv;
    for(let item of level.items) {
        console.assert((xMult * item.xLen) % xDiv === 0,
            `xDiv=${xDiv} does not divide item.xLen=${item.xLen}`);
        console.assert((yMult * item.yLen) % yDiv === 0,
            `yDiv=${yDiv} does not divide item.yLen=${item.yLen}`);
        item.xLen = (xMult * item.xLen) / xDiv;
        item.yLen = (yMult * item.yLen) / yDiv;
    }
}

function reloadWithDimMult(xMult, yMult=null, xDiv=1, yDiv=1) {
    if(yMult === null) {
        yMult = xMult;
    }
    if(game === null) {
        console.warn('attempt to reload an empty game');
        return;
    }
    let level = game.level;
    level.startPos = game.getItemPositions();
    const [gX, gY] = getGranularity(level);
    if(xDiv === null) {
        xDiv = gX;
    }
    if(yDiv === null) {
        yDiv = gY;
    }
    if(gX % xDiv !== 0) {
        console.error(`xDiv=${xDiv} does not divide gX=${gX}`);
        return;
    }
    if(gY % yDiv !== 0) {
        console.error(`yDiv=${yDiv} does not divide gY=${gY}`);
        return;
    }
    game.destroy();
    rescaleLevel(level, xMult, yMult, xDiv, yDiv);
    game = new Game(level, null);
}

//==[ Event Handling ]==========================================================

class ItemInfoBar {
    constructor(gameType) {
        let domElemNames = ['width', 'height'];
        if(gameType === 'ks') {
            domElemNames.push('profit');
        }
        this.barDom = document.getElementById('item-info-bar');
        this.domElems = createBarItems(this.barDom, domElemNames);
    }

    activate(item) {
        let d = {'width': item.xLen, 'height': item.yLen, 'profit': item.profit};
        for(let [key, value] of Object.entries(d)) {
            let domElem = this.domElems[key];
            if(domElem !== undefined) {
                domElem.innerHTML = value;
            }
        }
        this.barDom.classList.remove('disabled');
    }

    deactivate() {
        for(let [key, domElem] of Object.entries(this.domElems)) {
            domElem.innerHTML = '';
        }
        this.barDom.classList.add('disabled');
    }

    destroy() {
        this.barDom.innerHTML = '';
        this.barDom.classList.add('disabled');
        this.domElems = null;
    }
}

class DragData {
    constructor(itemId, coords, xOff, yOff) {
        this.itemId = itemId;
        this.coords = coords;
        this.xOff = xOff;
        this.yOff = yOff;
    }
    static get() {
        return globalDragData;
    }
    static set(dragData) {
        if(globalDragData !== null) {
            throw new Error('globalDragData is already set');
        }
        globalDragData = dragData;
        if(dragData.itemId !== null) {
            game.itemInfoBar.activate(game.items[dragData.itemId].itemInfo);
        }
        // ev.dataTransfer.setData('text/html', null);
    }
    static unset() {
        globalDragData = null;
        game.itemInfoBar.deactivate();
    }
}

function mousedownHandler(ev) {
    let target = ev.target;
    console.debug(ev.type, ev.clientX, ev.clientY, target);
    if(ev.button !== 0) {
        return;
    }
    let targetRect = target.getBoundingClientRect();
    if(target.classList.contains('item')) {
        ev.preventDefault();
        let itemId = parseInt(target.getAttribute('data-item-id'));
        if(mouseMode['item'] === 'delete') {
            const coords = game.getItemPosition(itemId);
            const itemInfo = game.level.items[itemId];
            game._recordHistoryCommand({'cmd': 'removeItem', 'itemId': itemId,
                'xLen': itemInfo.xLen, 'yLen': itemInfo.yLen,
                'color': itemInfo.color, 'profit': itemInfo.profit,
                'coords': coords});
            game.removeItem(itemId);
        }
        else if(mouseMode['item'] === 'drag') {
            let itemXOff = ev.clientX - targetRect.x, itemYOff = ev.clientY - targetRect.y;
            DragData.set(new DragData(itemId, game.getItemPosition(itemId), itemXOff, itemYOff));
            game.detach(itemId, true);
            target.classList.add('moving');
            hoverRect.style.height = targetRect.height + 'px';
            hoverRect.style.width = targetRect.width + 'px';
        }
    }
    else if(target.classList.contains('bin')) {
        ev.preventDefault();
        const binId = parseInt(target.getAttribute('data-bin-id'));
        if(mouseMode['bin'] === 'create') {
            const xPos = Math.floor((ev.clientX - targetRect.x) / game.scaleFactor);
            const yPos = Math.floor((ev.clientY - targetRect.y) / game.scaleFactor);
            DragData.set(new DragData(null, [binId, xPos, yPos], 0, 0));

            const selRect = new Rectangle(xPos, yPos, 1, 1);
            hoverRect.style.width = (game.scaleFactor * selRect.xLen) + 'px';
            hoverRect.style.height = (game.scaleFactor * selRect.yLen) + 'px';
            hoverRect.classList.add('success');
            hoverRect.classList.remove('failure');
            moveHoverRect(binId, selRect);
        }
    }
}

function getPos(ev, xLen, yLen, binId) {
    let dragData = DragData.get();
    let bin = game.bins[binId];
    let binRect = bin.domElem.getBoundingClientRect();
    let xPos = (ev.clientX - binRect.x - dragData.xOff) / game.scaleFactor;
    let yPos = (ev.clientY - binRect.y - dragData.yOff) / game.scaleFactor;
    xPos = clip(Math.round(xPos), 0, bin.bin.xLen - xLen);
    yPos = clip(Math.round(yPos), 0, bin.bin.yLen - yLen);
    return [xPos, yPos];
}

function moveHoverRect(binId, rect) {
    let bin = game.bins[binId];
    if((rect.xPos + rect.xLen > bin.bin.xLen) || (rect.yPos + rect.yLen > bin.bin.yLen)) {
        hoverRect.style.visibility = 'hidden';
    }
    else {
        const binRect = bin.domElem.getBoundingClientRect();
        setPos(hoverRect,
            binRect.x + rect.xPos * game.scaleFactor,
            binRect.y + rect.yPos * game.scaleFactor);
        hoverRect.style.visibility = 'visible';
    }
}

function inRect(xPos, yPos, domRect) {
    return (domRect.left <= xPos && xPos <= domRect.right)
        && (domRect.top <= yPos && yPos <= domRect.bottom);
}

function getMouseBinId(ev) {
    for(let i=0; i < game.bins.length; ++i) {
        let bin = game.bins[i];
        if(inRect(ev.clientX, ev.clientY, bin.domElem.getBoundingClientRect())) {
            return i;
        }
    }
    return null;
}

function getSelectionRect(ev, binId, xPos1, yPos1) {
    let binUI = game.bins[binId];
    const binXLen = binUI.bin.xLen, binYLen = binUI.bin.yLen;
    const binRect = binUI.domElem.getBoundingClientRect();
    let xPos2 = clip(Math.floor((ev.clientX - binRect.x) / game.scaleFactor),
        0, binXLen - 1);
    let yPos2 = clip(Math.floor((ev.clientY - binRect.y) / game.scaleFactor),
        0, binYLen - 1);
    if(xPos1 > xPos2) {
        [xPos1, xPos2] = [xPos2, xPos1];
    }
    if(yPos1 > yPos2) {
        [yPos1, yPos2] = [yPos2, yPos1];
    }
    const xLen = xPos2 - xPos1 + 1, yLen = yPos2 - yPos1 + 1;
    return new Rectangle(xPos1, yPos1, xLen, yLen);
}

function mousemoveHandler(ev) {
    // console.debug("mousemove", ev.target.id, ev.target.classList.value);
    let dragData = DragData.get();
    if(dragData === null) {
        return;
    }
    ev.preventDefault();
    if(dragData.itemId !== null) {
        // move item
        let item = game.items[dragData.itemId];
        let parentRect = item.domElem.parentNode.getBoundingClientRect();
        setPos(item.domElem, ev.clientX - dragData.xOff - parentRect.x,
            ev.clientY - dragData.yOff - parentRect.y);

        // draw hover
        let binId = getMouseBinId(ev);
        let bin = game.bins[binId];
        if(binId === null) {
            hoverRect.style.visibility = 'hidden';
        }
        else {
            let [xPos, yPos] = getPos(ev, item.itemInfo.xLen, item.itemInfo.yLen, binId);
            let newPosRect = new Rectangle(xPos, yPos, item.itemInfo.xLen, item.itemInfo.yLen);
            moveHoverRect(binId, newPosRect);
            if(bin.bin.canFit(newPosRect)) {
                hoverRect.classList.add('success');
                hoverRect.classList.remove('failure');
            }
            else {
                hoverRect.classList.add('failure');
                hoverRect.classList.remove('success');
            }
        }
    }
    else {
        let [binId, xPos1, yPos1] = dragData.coords;
        const selRect = getSelectionRect(ev, binId, xPos1, yPos1);
        hoverRect.style.width = (game.scaleFactor * selRect.xLen) + 'px';
        hoverRect.style.height = (game.scaleFactor * selRect.yLen) + 'px';
        moveHoverRect(binId, selRect);
        if(game.bins[binId].bin.canFit(selRect)) {
            hoverRect.classList.add('success');
            hoverRect.classList.remove('failure');
        }
        else {
            hoverRect.classList.add('failure');
            hoverRect.classList.remove('success');
        }
    }
}

function endDrag(hook=null) {
    hoverRect.style.visibility = 'hidden';
    let dragData = DragData.get();
    if(dragData !== null) {
        if(dragData.itemId !== null) {
            let oldCoords = dragData.coords;
            game._recordMove(dragData.itemId, oldCoords, game.getItemPosition(dragData.itemId));
            game.items[dragData.itemId].domElem.classList.remove('moving');
        }
        DragData.unset();
        game.trimBins(1);
        if(hook !== null) {hook();}
    }
}

function mouseupHandler(ev) {
    let target = ev.target;
    console.debug(ev.type, target);
    let dragData = DragData.get();
    if(dragData === null) {
        return;
    }
    ev.preventDefault();
    if(dragData.itemId !== null) {
        let itemId = dragData.itemId;
        let itemInfo = game.items[itemId].itemInfo;
        let binId = getMouseBinId(ev);

        // attach item to bin
        if(binId !== null) {
            let [xPos, yPos] = getPos(ev, itemInfo.xLen, itemInfo.yLen, binId);
            game.attach(itemId, binId, xPos, yPos);
        }
    }
    else {
        let [binId, xPos1, yPos1] = dragData.coords;
        const selRect = getSelectionRect(ev, binId, xPos1, yPos1);
        if(game.bins[binId].bin.canFit(selRect)) {
            let itemInfo = new ItemInfo(null, selRect.xLen, selRect.yLen, 0, null);
            game.pushItem(itemInfo);
            game.attach(game.items.length - 1, binId, selRect.xPos, selRect.yPos, true);
            game._recordHistoryCommand({'cmd': 'addItem', 'xLen': selRect.xLen,
                'yLen': selRect.yLen, 'coords': [binId, selRect.xPos, selRect.yPos]});
        }
    }
    endDrag();
}

function mouseleaveHandler(ev) {
    let target = ev.target;
    console.debug(ev.type, target);
    endDrag(() => ev.preventDefault());
}

function keydownHandler(ev) {
    if(handleKeyPresses && !ev.defaultPrevented) {
        const metaOrCtrl = ev.metaKey || ev.ctrlKey;
        if(ev.key === 'z' && metaOrCtrl) {
            ev.preventDefault();
            if(game !== null) {
                if(ev.shiftKey) {
                    game.redo();
                }
                else {
                    game.undo();
                }
            }
        }
        else if(ev.key === 's' && metaOrCtrl) {
            if(game !== null) {
                ev.preventDefault();
                downloadProgress();
            }
        }
        else if(ev.key === 'c' && metaOrCtrl) {
            if(game !== null) {
                ev.preventDefault();
                if(window.navigator.clipboard) {
                    let levelJSON = prettyJSONize(serializeLevel(
                        game.level, game.getItemPositions()));
                    window.navigator.clipboard.writeText(levelJSON)
                        .then(() => addMsg('info', 'Level JSON copied to clipboard.'))
                        .catch(() => addMsg('warning',
                            'Level JSON could not be copied to clipboard.'));
                }
            }
        }
        else if(ev.key === 'Escape') {
            endDrag(() => ev.preventDefault());
        }
    }
}


function addEventListeners() {
    arena.addEventListener('dragstart', function(ev) {
        console.debug('dragstart', ev.target);
        ev.preventDefault();
        return false;
    });

    arena.addEventListener('pointerdown', mousedownHandler);
    arena.addEventListener('pointermove', mousemoveHandler);
    arena.addEventListener('pointerup', mouseupHandler);
    arena.addEventListener('pointerleave', mouseleaveHandler);
    window.addEventListener('keydown', keydownHandler);

    document.getElementById('level-loader').addEventListener('change', function(ev) {
            if(ev.target.files.length > 0) {
                loadGameFromFiles(ev.target.files, uploadInfo['scaleFactor'],
                    uploadInfo['succHook'], uploadInfo['failHook']);
            }
        });
    document.body.addEventListener('dragover', function(ev) {
            ev.stopPropagation();
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
        });
}

//==[ Main ]====================================================================

window.addEventListener('load', function() {
    initThemeFromLocalStorage();
    addEventListeners();
    loadGameFromQParams(getQParams(), resetReloadButton, (msg) => addMsg('error', msg));
    addExtraUIEventListeners();
});
// @license-end
