'use strict';

var async = require('async');
var bitcore = require('bitcore-lib-zelcash');
var _ = bitcore.deps._;
var pools = require('../pools.json');
var BN = bitcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');

function BlockController(options) {
  var self = this;
  this.node = options.node;
  this.transactionService = options.transactionService;

  this.blockSummaryCache = LRU(options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE);
  this.blockCacheConfirmations = 6;
  this.blockCache = LRU(options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE);

  this.poolStrings = {};
  pools.forEach(function(pool) {
    pool.searchStrings.forEach(function(s) {
      self.poolStrings[s] = {
        poolName: pool.poolName,
        url: pool.url
      };
    });
  });

  this.common = new Common({ log: this.node.log });

}

var BLOCK_LIMIT = 200;

BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE = 1000000;
BlockController.DEFAULT_BLOCK_CACHE_SIZE = 1000;

function isHexadecimal(hash) {
  if (!_.isString(hash)) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(hash);
}


BlockController.prototype.checkBlockHash = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  if (hash.length < 64 || !isHexadecimal(hash)) {
    return self.common.handleErrors(null, res);
  }
  next();
};

/**
 * Find block by hash ...
 */
BlockController.prototype.block = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;

    return this.getBlockByHash(hash, function(err, blockResult) {
        if ((err && err.code === -5) || (err && err.code === -8)) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }

        req.block = blockResult;

        return next();
      });

};

/**
 *
 * @param {String} hash
 * @param {Function} next
 * @returns {*}
 */
BlockController.prototype.getBlockByHash = function(hash, next) {

    var self = this,
        blockCached = self.blockCache.get(hash);

    if (blockCached) {

        blockCached.confirmations = self.node.services.bitcoind.height - blockCached.height + 1;

        return next(null, blockCached);

    } else {

        var dataFlow = {
            block: null,
            info: null,
            reward: null,
            transaction: null
        };

        return async.waterfall([function (callback) {

            return self.node.getBlock(hash, function (err, block) {

                if (err) {
                    return callback(err);
            }

                dataFlow.block = block;

                return callback();
            });

        }, function (callback) {

            return self.node.services.bitcoind.getBlockHeader(hash, function (err, info) {

                if (err) {
                  return callback(err);
              }

              dataFlow.info = info;

              return callback();
          });

      }, function (callback) {

            return self.getBlockReward(dataFlow.info.height, function (err, result) {

                if (err) {
                    return callback(err);
                }

                dataFlow.reward = result;

                return callback();

            });

        }, function (callback) {

            if (dataFlow.info.height === 0) {
                return callback();
            }

            var txHash;


            txHash = dataFlow.block.transactions[0].hash;


            return self.transactionService.getDetailedTransaction(txHash, function (err, trx) {

            if (err) {
                    return callback(err);
                }

                dataFlow.transaction = trx;

                return callback();

            });
        }
        ], function (err) {

            if (err) {
                    return next(err);
                }

            var blockResult = self.transformBlock(dataFlow.block, dataFlow.info, dataFlow.reward, dataFlow.transaction);

                if (blockResult.confirmations >= self.blockCacheConfirmations) {
                    self.blockCache.set(hash, blockResult);
                }

            return next(null, blockResult);

            });

    }
};

/**
 * Find rawblock by hash and height...
 */
BlockController.prototype.rawBlock = function(req, res, next) {
  var self = this;
  var blockHash = req.params.blockHash;

  self.node.getRawBlock(blockHash, function(err, blockBuffer) {
    if((err && err.code === -5) || (err && err.code === -8)) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }
    req.rawBlock = {
      rawblock: blockBuffer.toString('hex')
    };
    next();
  });

};

BlockController.prototype._normalizePrevHash = function(hash) {
  // TODO fix bitcore to give back null instead of null hash
  if (hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
    return hash;
  } else {
    return null;
  }
};

BlockController.prototype.transformBlock = function(block, info, reward, transaction) {
  var blockObj = block.toObject();
  var transactionIds = blockObj.transactions.map(function(tx) {
    return tx.hash;
  });

  var poolAddress;

  if (transaction) {
    transaction.outputs.forEach(function (output) {
        if (output.satoshis > (reward * 0.6)) {
            poolAddress = output.address;
        }
    });
  }

  return {
    hash: block.hash,
    size: block.toBuffer().length,
    height: info.height,
    version: blockObj.header.version,
    merkleroot: blockObj.header.merkleRoot,
    tx: transactionIds,
    time: blockObj.header.time,
    nonce: blockObj.header.nonce,
    bits: blockObj.header.bits.toString(16),
    difficulty: block.header.getDifficulty(),
    chainwork: info.chainWork,
    confirmations: info.confirmations,
    previousblockhash: this._normalizePrevHash(blockObj.header.prevHash),
    nextblockhash: info.nextHash,
    reward: reward / 1e8,
    isMainChain: (info.confirmations !== -1),
    minedBy: poolAddress,
    solution: blockObj.header.solution,
    poolInfo: this.getPoolInfo(poolAddress)
  };

};

/**
 * Show block
 */
BlockController.prototype.show = function(req, res) {
  if (req.block) {
    res.jsonp(req.block);
  }
};

BlockController.prototype.showRaw = function(req, res) {
  if (req.rawBlock) {
    res.jsonp(req.rawBlock);
  }
};

BlockController.prototype.blockIndex = function(req, res) {
  var self = this;
  var height = req.params.height;
  this.node.services.bitcoind.getBlockHeader(parseInt(height), function(err, info) {
    if (err) {
      return self.common.handleErrors(err, res);
    }
    res.jsonp({
      blockHash: info.hash
    });
  });
};

BlockController.prototype._getBlockSummary = function(hash, moreTimestamp, next) {

  var self = this;

  function finish(result) {
    if (moreTimestamp > result.time) {
      moreTimestamp = result.time;
    }
    return next(null, result);
  }

  var summaryCache = self.blockSummaryCache.get(hash);

  if (summaryCache) {

      return async.setImmediate(function() {
          finish(summaryCache);
      });

  } else {

        var block;
        var transaction;

        return async.waterfall([function (callback) {
            return self.node.services.bitcoind.client.getBlock(hash, function (err, response) {

      if (err) {
          return callback(err);
      }

                if (!response) {
                    return callback('Error getBlock');
                }

                block = response.result;

                return callback();

            });
        }, function (callback) {

            var txHash;


            txHash = block.tx[0];

            return self.transactionService.getDetailedTransaction(txHash, function (err, trx) {

        if (err) {
                    return callback(err);
                }

                transaction = trx;

                return callback();

            });

        }], function (err) {

            if (err) {
          return next(err);
        }

        var spoolAddress;
        var sreward = self.getBlockRewardr(block.height);

        transaction.outputs.forEach(function (output) {
            if (output.satoshis > (sreward * 0.6)) {
                spoolAddress = output.address;
            }
        });

        var summary = {
                height: block.height,
                size: block.size,
                hash: block.hash,
                time: block.time,
                txlength: block.tx.length,
                poolInfo: self.getPoolInfo(spoolAddress),
                isMainChain: (block.confirmations !== -1)
        };

        summary.minedBy = spoolAddress

        var confirmations = self.node.services.bitcoind.height - block.height + 1;

        if (confirmations >= self.blockCacheConfirmations) {
          self.blockSummaryCache.set(hash, summary);
        }

            return finish(summary);

      });

  }
};

// List blocks by date
BlockController.prototype.list = function(req, res) {
  var self = this;

  var dateStr;
  var todayStr = this.formatTimestamp(new Date());
  var isToday;

  if (req.query.blockDate) {
    dateStr = req.query.blockDate;
    var datePattern = /\d{4}-\d{2}-\d{2}/;
    if(!datePattern.test(dateStr)) {
      return self.common.handleErrors(new Error('Please use yyyy-mm-dd format'), res);
    }

    isToday = dateStr === todayStr;
  } else {
    dateStr = todayStr;
    isToday = true;
  }

  var gte = Math.round((new Date(dateStr)).getTime() / 1000);

  //pagination
  var lte = parseInt(req.query.startTimestamp) || gte + 86400;
  var prev = this.formatTimestamp(new Date((gte - 86400) * 1000));
  var next = lte ? this.formatTimestamp(new Date(lte * 1000)) : null;
  var limit = parseInt(req.query.limit || BLOCK_LIMIT);
  var more = false;
  var moreTimestamp = lte;

    return self.node.services.bitcoind.getBlockHashesByTimestamp(lte, gte, function (err, hashes) {

        if (err) {
      return self.common.handleErrors(err, res);
    }

    hashes.reverse();

        var i = 0;
        var mainChainBlocks = [];

        return async.whilst(function () {

            if (!hashes.length) {
                return false;
    }

            if (mainChainBlocks.length >= limit) {
                return false;
            }

            return hashes.length > i;

        }, function (callback) {

            var hash = hashes[i];

            return self._getBlockSummary(hash, moreTimestamp, function (err, block) {

                if (err) {
                    return callback(err);
                }

                if (block.isMainChain) {
                    mainChainBlocks.push(block);
                }

                i++;

                return callback();
            });

        }, function (err) {

            if (err) {
          return self.common.handleErrors(err, res);
        }

            if (hashes[i + 1]) {
                more = true;
            }

        mainChainBlocks.sort(function (a, b) {
          return b.height - a.height;
        });

        var data = {
          blocks: mainChainBlocks,
          length: mainChainBlocks.length,
          pagination: {
            next: next,
            prev: prev,
            currentTs: lte - 1,
            current: dateStr,
            isToday: isToday,
            more: more
          }
        };

        if (more && mainChainBlocks.length) {
            data.pagination.moreTs = mainChainBlocks[mainChainBlocks.length - 1].time;
        }

        return res.jsonp(data);

      });

    });
};

BlockController.prototype.getPoolInfo = function(paddress) {
  if (paddress) {
  for(var k in this.poolStrings) {
    if (paddress.toString().match(k)) {
      return this.poolStrings[k];
    }
  }
  }
  return {};
};

//helper to convert timestamps to yyyy-mm-dd format
BlockController.prototype.formatTimestamp = function(date) {
  var yyyy = date.getUTCFullYear().toString();
  var mm = (date.getUTCMonth() + 1).toString(); // getMonth() is zero-based
  var dd = date.getUTCDate().toString();

  return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]); //padding
};

BlockController.prototype.getBlockReward = function(height, callback) {
  var subsidy;

  if (height == 0) {
    subsidy = new BN(0);
  } else if (height < 77777) {
    subsidy = new BN(21000 * 1e8);
  } else if (height < 200000) {
    subsidy = new BN(16000 * 1e8);
  } else if (height < 30000) {
    subsidy = new BN(15000 * 1e8);
  } else if (height < 500001) {
    subsidy = new BN(625 * 1e8);
  } else if (height < 600001) {
    subsidy = new BN(312.5 * 1e8);
  } else if (height < 700001) {
    subsidy = new BN(156.25 * 1e8);
  } else if (height < 800001) {
    subsidy = new BN(78 * 1e8);
  } else if (height < 900001) {
    subsidy = new BN(39 * 1e8);
  } else if (height < 1000001) {
    subsidy = new BN(19.5 * 1e8);
  } else if (height < 3102401) {
    subsidy = new BN(8 * 1e8);
  } else {
    var halvings = Math.floor(height - 3102400 / 2102400);
    if (halvings >= 64) {
      return 0;
    }
    subsidy = new BN(4 * 1e8);
    subsidy = subsidy.shrn(halvings);
  }
  var sub;
  sub = parseInt(subsidy.toString(10));
  callback(null, sub);
};

BlockController.prototype.getBlockRewardr = function(height) {
  var subsidy;

  if (height == 0) {
    subsidy = new BN(0);
  } else if (height < 77777) {
    subsidy = new BN(21000 * 1e8);
  } else if (height < 300000) {
    subsidy = new BN(15000 * 1e8);
  } else if (height < 400001) {
    subsidy = new BN(10000 * 1e8);
  } else if (height < 500001) {
    subsidy = new BN(625 * 1e8);
  } else if (height < 600001) {
    subsidy = new BN(312.5 * 1e8);
  } else if (height < 700001) {
    subsidy = new BN(156.25 * 1e8);
  } else if (height < 800001) {
    subsidy = new BN(78 * 1e8);
  } else if (height < 900001) {
    subsidy = new BN(39 * 1e8);
  } else if (height < 1000001) {
    subsidy = new BN(19.5 * 1e8);
  } else if (height < 3102401) {
    subsidy = new BN(8 * 1e8);
  } else {
    var halvings = Math.floor(height - 3102400 / 2102400);
    if (halvings >= 64) {
      return 0;
    }
    subsidy = new BN(4 * 1e8);
    subsidy = subsidy.shrn(halvings);
  }

  return parseInt(subsidy.toString(10));
};

module.exports = BlockController;
