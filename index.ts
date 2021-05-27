import * as dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { Twilio } from 'twilio';
import { CompositionInstance } from 'twilio/lib/rest/video/v1/composition';
import { Server } from 'socket.io';

dotenv.config();
const port = process.env.PORT || 5000;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

const twilioClient = new Twilio(
  process.env.TWILIO_API_KEY as string,
  process.env.TWILIO_API_SECRET as string,
  { accountSid: process.env.TWILIO_ACCOUNT_SID as string }
);

interface VideoRoom {
  sid: string;
  name: string;
  duration: number;
  compositions: CompositionInstance[];
}

const getRoomsAndCompositions = async () => {
  let rooms = [];
  let compositions: CompositionInstance[] = [];

  try {
    // Get a list of recent video rooms. In this case, the 10 most recent completed rooms
    rooms = await twilioClient.video.rooms.list({status: 'completed', limit: 10});

    // Get a list of recordings
    let recordings = await twilioClient.video.recordings.list();

    // Create a list of only the room sids that have associated recordings
    let roomSidsWithRecordings: string[] = recordings.map((recording) => {
      return recording.groupingSids.room_sid
    })

    // Filter out the duplicates
    const setOfRoomSidsWithRecordings: string[] = [...new Set(roomSidsWithRecordings)]

    // Get the full details of the rooms with recordings
    const roomsWithRecordings = rooms.filter((room) => {
      if (setOfRoomSidsWithRecordings.includes(room.sid)) {
        return room;
      }
    });

    // Get a list of completed compositions
    compositions = await twilioClient.video.compositions.list({status: 'completed'});

    let videoRooms: VideoRoom[] = [];

    // Match up any completed compositions with their associated rooms
    roomsWithRecordings.forEach((room) => {
      const roomCompositions = compositions.filter(composition => composition.roomSid === room.sid);

      let VideoRoom: VideoRoom = {
        sid: room.sid,
        name: room.uniqueName,
        duration: room.duration,
        compositions: roomCompositions
      }

      videoRooms.push(VideoRoom);
    })

    // Return this list of video rooms and associated compositions
    return videoRooms;

  } catch (error) {
    console.log(error)
    return error;
  }
}

/**
 * Display the last 10 completed video rooms and compositions when the page loads
 */
app.get('/', async (req, res, next) => {
  try {
    let rooms = await getRoomsAndCompositions();
    return res.render('index.pug', { rooms });

  } catch (error) {
    return res.status(400).send({
      message: `Unable to list rooms`,
      error
    });
  }
});

/**
 * Compose a video room
 */
app.get('/compose/:sid', async (req, res, next) => {
  // Get the room sid from the request. If there is no room sid present, return an error message
  if (!req.params.sid) {
    return res.status(400).send({
      message: `No value provided for roomSid`
    });
  }

  const roomSid: string = req.params.sid;

  try {
    // Get the room's recordings and compose them
    const recordings = await twilioClient.video.recordings.list({ groupingSid: [roomSid] });

    // Send a request to Twilio to create the composition
    let createComposition = await twilioClient.video.compositions.create({
      roomSid: roomSid,
      audioSources: '*',
      videoLayout: {
        grid : {
          video_sources: ['*']
        }
      },
      statusCallback: 'http://4e72141b3691.ngrok.io/callback',
      format: 'mp4'
    });

    res.status(200).send({
      message: `Creating composition with sid=${createComposition.sid}`,
    });

    // Emit an event to update the status on the client side
    io.emit('status-update', 'composition-request');
    return;

  } catch (error) {
    return res.status(400).send({
      message: `Unable to create composition for room with sid=${roomSid}`,
      error
    });
  }
});

/**
 * Callback with status updates
 */
app.post('/callback', async (req, res, next) => {
  const status = req.body.StatusCallbackEvent;
  io.emit('status-update', status);
  return res.status(200).send(status);
});


/**
 * View the composition in the browser
 */
app.get('/compositions/:sid/view', async (req, res, next) => {
  if (!req.params.sid) {
    return res.status(400).send({
      message: `No value provided for composition sid`
    });
  }

  const compositionSid = req.params.sid;

  try {
    // Get the composition by its sid.
    // Setting ContentDisposition to inline will allow you to view the video in your browser.
    const uri = `https://video.twilio.com/v1/Compositions/${compositionSid}/Media?Ttl=3600&ContentDisposition=inline`;

    let compResponse = await twilioClient.request({
      method: 'GET',
      uri: uri
    })

    return res.redirect(compResponse.body.redirect_to);

  } catch (error) {
    return res.status(400).send({
      message: `Unable to get composition with sid=${compositionSid}`,
      error
    });
  }
});

/**
 * Download the composition
 */
app.get('/compositions/:sid/download', async (req, res, next) => {
  if (!req.params.sid) {
    return res.status(400).send({
      message: `No value provided for composition sid`
    });
  }

  const compositionSid = req.params.sid;

  try {
    // Get the composition by its sid.
    // ContentDisposition defaults to attachment, which prompt your browser to download the file locally.
    const uri = `https://video.twilio.com/v1/Compositions/${compositionSid}/Media?Ttl=3600`;

    let compResponse = await twilioClient.request({
      method: 'GET',
      uri: uri
    });

    return res.redirect(compResponse.body.redirect_to);

  } catch (error) {
    console.log(error)
    return res.status(400).send({
      message: `Unable to get composition with sid=${compositionSid}`,
      error
    });
  }
});

/**
 * Delete a composition
 */
app.get('/compositions/:sid/delete', async (req, res, next) => {
  if (!req.params.sid) {
    return res.status(400).send({
      message: `No value provided for composition sid`
    });
  }

  const compositionSid: string = req.params.sid;

  try {
    // Delete the composition
    let compResponse = await twilioClient.video.compositions(compositionSid).remove();

    io.emit('status-update', 'composition-deleted');
    return res.status(200).send({
      message: `Deleted composition with sid=${compositionSid}`,
    });

  } catch (error) {
    return res.status(400).send({
      message: `Unable to delete composition with sid=${compositionSid}`,
      error
    });
  }
});

const server = app.listen(port, () => {
  console.log(`Express server running on port ${port}`);
});

const io = new Server(server);

io.on('connection', (socket) => {
  console.log('connected!');
});