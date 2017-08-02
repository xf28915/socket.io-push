module.exports = (deviceService, notificationService, ttlService, batchSize, bufferSize, remoteUrls, stats) => {
  return new ApiRouter(deviceService, notificationService, ttlService, batchSize, bufferSize, remoteUrls, stats);
};

const logger = require('winston-proxy')('ApiRouter');
const request = require('request');
const pushEvent = 'push';
const randomstring = require('randomstring');
const versionCompare = require('../util/versionCompare');

class ApiRouter {

  constructor(deviceService, notificationService, ttlService, batchSize, bufferSize, remoteUrls, stats) {
    this.deviceService = deviceService;
    this.stats = stats;
    this.notificationService = notificationService;
    this.ttlService = ttlService;
    this.batchSize = batchSize || 1000;
    this.remoteUrls = require("../util/infiniteArray")(remoteUrls);
    this.notificationBuffer = []; // 保证notification只有一个‘线程’ 读取数据库，防止蜂拥
    this.bufferSize = bufferSize || 0;
    this.bufferTask = null;
  }

  splitTargets(targets) {
    let split;
    let done = false;
    if (targets > this.bufferSize) {
      split = [];
      for (let i = 0; i < this.bufferSize; i++) {
        split.push(targets[0]);
      }
      targets.splice(0, this.bufferSize)
    } else {
      split = targets;
      done = true;
    }
    return {
      split,
      done
    }
  }

  sendFromBuffer() {
    if (this.notificationBuffer.length > 0) {
      const notiParams = this.notificationBuffer[this.notificationBuffer.length - 1];
      if (notiParams.pushIds) {
        const split = this.splitTargets(notiParams.pushIds);
        if (split.done) {
          this.notificationBuffer.shift();
        }
        this.deviceService.getDevicesByPushIds(split.split, (devices) => {
          this.sendNotificationByDevices(notiParams, devices);
          this.bufferTaskDone();
        });
      } else if (notiParams.uids) {
        const split = this.splitTargets(notiParams.uids);
        if (split.done) {
          this.notificationBuffer.shift();
        }
        this.deviceService.getDevicesByUid(split.split, (devices) => {
          this.sendNotificationByDevices(notiParams, devices);
          this.bufferTaskDone();
        });
      } else if (notiParams.tag) {
        let batch = [];
        this.deviceService.scanByTag(notiParams.tag, (doc) => {
          batch.push(doc);
          if (batch.length == this.maxPushIds) {
            this.sendNotificationByDevices(notiParams, batch);
            batch = [];
          }
        }, () => {
          if (batch.length != 0) {
            this.sendNotificationByDevices(notiParams, batch);
          }
          this.bufferTaskDone();
        });
      }
    }
    this.notificationBuffer.shift();
  }

  bufferTaskDone() {
    this.bufferTask = null;
    this.postBufferTask();
  }

  postBufferTask() {
    logger.debug('postBufferTask bufferSize', this.notificationBuffer.length);
    if (this.bufferSize > 0 && this.notificationBuffer.length > this.bufferSize) {
      logger.error('postBufferTask bufferSize too big dropping all', this.notificationBuffer.length);
      this.notificationBuffer = [];
    }
    if (this.bufferTask == null && this.notificationBuffer.length > 0) {
      this.bufferTask = setTimeout(() => {
        this.sendFromBuffer();
      }, 0);
    }
  }

  notification(params) {
    this.addIdAndTimestamp(params.notification);
    if (params.pushAll) {
      this.notificationService.sendAll(params.notification, params.timeToLive);
    } else {
      this.notificationBuffer.push(params);
      this.postBufferTask();
    }
    return params.notification.id;
  }

  push(pushData, topic, pushIds, uids, timeToLive) {
    if (pushIds) {
      pushIds.forEach((id) => {
        this.ttlService.addTTL(id, pushEvent, timeToLive, pushData, true);
        this.ttlService.emitPacket(id, pushEvent, pushData);
      });
    } else if (uids) {
      uids.forEach((id) => {
        const topic = "uid:" + id;
        this.ttlService.addTTL(topic, pushEvent, timeToLive, pushData, true);
        this.ttlService.emitPacket(topic, pushEvent, pushData);
      });
    } else if (topic) {
      this.ttlService.addTTL(topic, pushEvent, timeToLive, pushData, false);
      this.ttlService.emitPacket(topic, pushEvent, pushData);
    }
  }

  sendNotificationByDevices(params, devices) {
    this.filterByTag(params, devices);
    if (!devices || devices.length == 0) {
      return;
    }
    this.stats.addSuccess('notificationByDevices', devices.length);
    this.notificationService.sendByDevices(devices, params.timeToLive, params.notification);
  }

  filterByTag(params, devices) {
    if ((params.tagStart && params.tagLessThan) || (params.tagStart && params.tagGreaterThan)) {
      for (let i = devices.length - 1; i >= 0; i--) {
        let match = false;
        if (devices[i].tags) {
          for (const tag of devices[i].tags) {
            if (tag.startsWith(params.tagStart)) {
              const tail = tag.substr(params.tagStart.length);
              if (params.tagLessThan) {
                if (versionCompare(tail, params.tagLessThan) < 0) {
                  match = true;
                } else {
                  break;
                }
              }
              if (params.tagGreaterThan) {
                if (versionCompare(tail, params.tagGreaterThan) > 0) {
                  match = true;
                } else {
                  match = false;
                }
              }
              break;
            }
          }
        }
        if (!match) {
          logger.debug('do not match ', devices[i]);
          devices.splice(i, 1);
        }
      }
    }
  }

  addIdAndTimestamp(notification) {
    if (!notification.id) {
      notification.id = randomstring.generate(12);
    }
    if (!notification.timestamp) {
      notification.timestamp = Date.now();
    }
  }

}
