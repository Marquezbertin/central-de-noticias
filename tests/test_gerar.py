# -*- coding: utf-8 -*-
import sys
sys.path.insert(0, 'scripts')

from gerar import limpar, _finalizar, tokens, normaliza


def test_limpar_html():
    assert 'Brasil' in limpar('<p>Brasil</p>')


def test_finalizar():
    assert _finalizar('Texto') == 'Texto.'
    assert _finalizar('Texto!') == 'Texto!'
    assert _finalizar('Texto.   ') == 'Texto.'


def test_tokens_removes_short_and_stop():
    t = tokens('o brasil')
    assert 'brasil' in t


def test_normaliza():
    assert normaliza('Brasil & Política') == 'brasil  política'

