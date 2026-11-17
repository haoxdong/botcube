from botcube_harness_deepagents import message_times


def test_progress_waits_for_the_public_start_and_end() -> None:
    clock = message_times.TurnClock()
    clock.begin('question', 0)
    clock.start('thought', 100)
    assert clock.snapshot(1000)['at'] == 100
    assert clock.snapshot(1000)['steps'] == {}
    clock.public_start('thought')
    assert clock.snapshot(1000)['at'] == 1000
    clock.end('thought', 1200)
    assert clock.snapshot(1500)['at'] == 1200
    assert clock.snapshot(1500)['steps']['thought'] == {'started_at': 100}
    clock.public_end('thought')
    assert clock.snapshot(1500)['steps']['thought'] == {'started_at': 100, 'ended_at': 1200}
    assert clock.snapshot(1500)['at'] == 1500


def test_a_preface_and_its_first_tool_share_one_timing_identity() -> None:
    clock = message_times.TurnClock()
    clock.begin('question', 0)
    clock.start('model', 100)
    clock.public_start('model')
    clock.tool_started('first', 'model', 500)
    clock.tool_started('second', 'model', 700)
    assert clock.tool_id('first') == 'model'
    assert clock.tool_id('second') == 'second'
    clock.public_start('second')
    assert clock.snapshot(1000)['steps'] == {
        'model': {'started_at': 100}, 'second': {'started_at': 700},
    }
    clock.model_finished('model', 1100)
    assert clock.snapshot(1200)['steps']['model'] == {'started_at': 100}
    clock.tool_finished('first', 1500)
    clock.public_end('model')
    assert clock.snapshot(1600)['steps']['model']['ended_at'] == 1500


def test_the_terminal_model_end_freezes_before_checkpoint_overhead() -> None:
    clock = message_times.TurnClock()
    clock.begin('question', 0)
    clock.start('answer', 100)
    clock.public_start('answer')
    clock.model_finished('answer', 1200)
    clock.public_end('answer')
    assert clock.snapshot(5000)['at'] == 1200
    assert clock.snapshot(5000)['ended_at'] == 1200


def test_a_pending_parallel_boundary_limits_progress_without_reordering() -> None:
    clock = message_times.TurnClock()
    clock.begin('question', 0)
    clock.tool_started('slow', 'model', 100)
    clock.public_start('model')
    clock.tool_started('fast', 'model', 200)
    assert clock.snapshot(500)['at'] == 200
    clock.public_start('fast')
    clock.tool_finished('fast', 700)
    assert clock.snapshot(1000)['at'] == 700
    clock.public_end('fast')
    clock.tool_finished('slow', 1200)
    clock.public_end('model')
    assert list(clock.snapshot(1500)['steps']) == ['model', 'fast']


def test_saved_projection_keeps_the_version_and_individual_call_boundaries() -> None:
    from langchain_core.messages import AIMessage, HumanMessage

    from botcube_harness_deepagents.conversation import MESSAGE_TIMES, conversation

    question = message_times.asked(HumanMessage('Compare markets', id='question'), 0, canonical=True)
    reply = AIMessage('Check the sources', id='provider-message', tool_calls=[
        {'id': 'first', 'name': 'execute', 'args': {}},
        {'id': 'second', 'name': 'execute', 'args': {}},
    ], response_metadata={MESSAGE_TIMES: {
        'started_at': 100, 'ended_at': 1000, 'reasoning': [],
        'tool_calls': {'first': 300, 'second': 800}, 'timing_id': 'model',
        'tool_timing_ids': {'first': 'model', 'second': 'second'},
    }})
    [saved_question, saved_reply] = conversation([question, reply])
    assert saved_question['metadata']['worklog_clock'] == {'version': 1}
    assert saved_reply['metadata']['timing_id'] == 'model'
    [first, second] = saved_reply['toolCalls']
    assert first['metadata'] == {'timing_id': 'model', 'worklog_started_at': 100}
    assert second['metadata'] == {'timing_id': 'second', 'worklog_started_at': 800}


def test_clock_heartbeat_cancels_its_source_when_the_client_disconnects() -> None:
    import asyncio

    from ag_ui.core import RunStartedEvent
    from langchain_core.messages import HumanMessage

    from botcube_harness_deepagents.graph_stream import clock_events

    async def exercise() -> None:
        closed = asyncio.Event()
        blocked = asyncio.Event()

        async def source():
            message_times.asked(HumanMessage('Compare', id='question'), message_times.now())
            try:
                yield RunStartedEvent(thread_id='session', run_id='run')
                await blocked.wait()
            finally:
                closed.set()

        stream = clock_events(source(), lambda: None, canonical=True)
        started = await anext(stream)
        admitted = started.metadata['worklog_clock']['at']
        await anext(stream)
        heartbeat = await anext(stream)
        [operation] = heartbeat.model_dump(mode='json')['delta']
        assert operation['value']['at'] >= admitted + 900
        await stream.aclose()
        assert closed.is_set()

    asyncio.run(exercise())


def test_error_clock_frame_precedes_the_terminal_event() -> None:
    import asyncio

    from ag_ui.core import EventType, RunErrorEvent, RunStartedEvent
    from langchain_core.messages import HumanMessage

    from botcube_harness_deepagents.graph_stream import clock_events

    async def exercise() -> None:
        async def source():
            message_times.asked(HumanMessage('Compare', id='question'), message_times.now())
            yield RunStartedEvent(thread_id='session', run_id='run')
            yield RunErrorEvent(message='Stopped')

        events = [event async for event in clock_events(source(), lambda: None, canonical=True)]
        assert events[-1].type == EventType.RUN_ERROR
        [operation] = events[-2].model_dump(mode='json')['delta']
        assert operation['value']['ended_at'] == operation['value']['at']

    asyncio.run(exercise())
